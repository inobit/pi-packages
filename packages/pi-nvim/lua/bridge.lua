-- @inobit/pi-nvim — 常驻 daemon 内桥接（lua/bridge.lua，方案 §五）。
--
-- 双入口（经 --remote-send 按键式 `:lua PiNvim.<fn>('<req>','<res>')` 调用）：
-- - `PiNvim.diagnose(req, res)`：只读诊断（pull 查询语义：逐 client 发
--   `textDocument/diagnostic` 请求，响应即终点；无 pull 能力的 client 进 push 回退），绝不写盘。
-- - `PiNvim.format(req, res)`：逐文件模拟用户按 `:w`（普通 `:w`，用户 autocmd 即
--   formatter 管道；桥接不显式调 buf.format、不用 noautocmd、不选边）。
-- 两定时器（异常兜底，常规管理靠 pi 侧事件）：
-- - 空闲 TTL：idleMs 无请求且无在途任务 → 有界停全部 clients＋wipe 全部文件 buffer
--   （剩裸 nvim，~30MB；下次调用秒级重建）。
-- - 父探测：parentPollMs 轮询 vim.uv.os_getppid() 存活，死则停＋wipe＋删 socket 目录＋`:qa!`。
--
-- 请求文件：{files=[...], startupMs, diagnosticMs}；结果文件：{per_file=[...], total_ms}。

local PiNvim = {}

-- 状态（先立 flag：begin_shutdown 后 process 直接回错，见 Correctness-3）
PiNvim._shutdown = false
PiNvim._busy = false
-- 在途请求登记：_reqs[id] 记该请求的 buffers＋abort 标记（id＝req-<n>，TS 生成）。
-- 全部 abort 状态按请求分桶，**不用全局标记**（P2-4）：TS 收到 signal 即抛错，
-- 可能在 Lua 仍在处理上一个请求时就发起下一个（vim.wait 会泵事件循环、remote-send
-- 可重入），全局标记会让孤儿请求提前退出等待，随后它的 abort_cleanup 把新请求
-- 正在用的同名 buffer 删掉（句柄相同），新请求 collect 失败记成 bridge error。
PiNvim._reqs = {}
PiNvim._last_req_ms = vim.uv.now()

-- daemon 常驻 progress 记录（LspProgress 无轮询接口，只能事件常驻记录）。
-- push“还在干活”证据的唯一来源：超时不再是“等了半天没等到”，而是“抓到未结束的
-- progress”。PiNvim._progress[key] = {client_id=, began_at=, ended_at=}（ended 的懒 GC）。
-- 古董 nvim 无 LspProgress 事件时此处 pcall 吞掉：busy 证据恒空，静默一律判干净（降级，注释钉死）。
PiNvim._progress = {}

local function progress_key(client_id, token)
  return tostring(client_id) .. "\0" .. tostring(token)
end

local function setup_progress_watch()
  local ok, grp = pcall(vim.api.nvim_create_augroup, "PiNvimProgress", { clear = true })
  if not ok then
    return
  end
  pcall(vim.api.nvim_create_autocmd, "LspProgress", {
    group = grp,
    callback = function(ev)
      local data = ev.data or {}
      local params = data.params or {}
      local value = params.value or {}
      local key = progress_key(data.client_id, params.token)
      local now = vim.uv.now()
      if value.kind == "begin" then
        PiNvim._progress[key] = { client_id = data.client_id, began_at = now }
      elseif value.kind == "end" then
        local r = PiNvim._progress[key]
        if r ~= nil then
          r.ended_at = now
        end
      end
      -- report：只关心开合，不管进度条
      -- 懒 GC：条目超 500 删 ended 超 5min 的；还超则全清（progress 只是短暂证据）
      local n = 0
      for _ in pairs(PiNvim._progress) do
        n = n + 1
      end
      if n > 500 then
        for k, r in pairs(PiNvim._progress) do
          if r.ended_at ~= nil and now - r.ended_at > 300000 then
            PiNvim._progress[k] = nil
          end
        end
      end
    end,
  })
end

-- pull 查询语义（替代已删的批级 settle）：push 是“等一个永远不说发完了的通知”，
-- 只能靠静默秒数猜，慢 analyzer（如 gopls slicescontains，冷时 5~7s 才 publish）必漏；
-- pull 是请求-响应，响应（或请求超时）即终点，不猜——等的不是猜测，是 server 的现场计算。
local function sort_diags(out)
  table.sort(out, function(a, b)
    if a.severity ~= b.severity then
      return a.severity < b.severity
    end
    if a.line ~= b.line then
      return a.line < b.line
    end
    return a.col < b.col
  end)
  return out
end

-- buffer 内容哈希（发布时记，缓存命中判定用）：内容未变 ⇒ 该次发布的诊断仍对应当前内容
local function buf_content_hash(bufnr)
  local ok, lines = pcall(vim.api.nvim_buf_get_lines, bufnr, 0, -1, false)
  if not ok then
    return nil
  end
  return vim.fn.sha256(table.concat(lines, "\n"))
end

-- LSP 诊断 → 结果 shape（pull items 与 publish diagnostics 同形，client 由调用方给出）
local function map_lsp_diags(items, client_name)
  local out = {}
  for _, d in ipairs(items or {}) do
    local st = (d.range and d.range.start) or {}
    table.insert(out, {
      line = (st.line or 0) + 1,
      col = (st.character or 0) + 1,
      severity = (d.severity == 1 or d.severity == 2 or d.severity == 3) and d.severity or 4,
      source = d.source or "lsp",
      message = d.message or "",
      client = client_name,
    })
  end
  return sort_diags(out)
end

-- publishDiagnostics 观测表（PiNvim._publishes[key] = {at=, hash=, name=, diags=}）＋常驻包装。
-- push 的唯一精确信号源：**空发布也可见**（干净文件 server 也会推空列表，
-- 这是“真 clean”的证据，而计数法看不见）。包装后仍调原 handler（nvim 行为不变；
-- 原 handler 可能来自用户配置）。handler 缺失（古董 nvim）时降级：push 信号全空。
PiNvim._publishes = {}

local function setup_publish_watch()
  local handlers = vim.lsp.handlers
  if type(handlers) ~= "table" then
    return
  end
  local orig = handlers["textDocument/publishDiagnostics"]
  handlers["textDocument/publishDiagnostics"] = function(err, result, ctx, config)
    if result ~= nil and result.uri ~= nil and ctx ~= nil and ctx.client_id ~= nil then
      local name = nil
      local c = vim.lsp.get_client_by_id(ctx.client_id)
      if c ~= nil then
        name = c.name
      end
      local hash = nil
      local okb, b = pcall(vim.uri_to_bufnr, result.uri)
      if okb and b ~= nil and vim.api.nvim_buf_is_valid(b) then
        hash = buf_content_hash(b)
      end
      PiNvim._publishes[tostring(ctx.client_id) .. "\0" .. result.uri] = {
        at = vim.uv.now(),
        hash = hash,
        name = name,
        diags = map_lsp_diags(result.diagnostics, name),
      }
      -- 懒 GC：条目超 2000 删 10min 前的（只是最近真相的登记表）
      local n = 0
      for _ in pairs(PiNvim._publishes) do
        n = n + 1
      end
      if n > 2000 then
        local now = vim.uv.now()
        for k, r in pairs(PiNvim._publishes) do
          if now - r.at > 600000 then
            PiNvim._publishes[k] = nil
          end
        end
      end
    end
    if orig ~= nil then
      return orig(err, result, ctx, config)
    end
    if vim.lsp.diagnostic ~= nil and vim.lsp.diagnostic.on_publish_diagnostics ~= nil then
      return vim.lsp.diagnostic.on_publish_diagnostics(err, result, ctx, config)
    end
  end
end

-- 未结束且开始于 t0 之后（含 t0）的 progress 所属 client 名
-- （限定在给定 buffers 的 clients 内；t0 取请求开始≈didOpen，server 在此之后开工才算数）。
local function busy_push_clients(bufnrs, t0)
  local ids = {}
  for _, b in ipairs(bufnrs) do
    if b ~= nil and vim.api.nvim_buf_is_valid(b) then
      for _, c in ipairs(vim.lsp.get_clients({ bufnr = b })) do
        ids[c.id] = c.name
      end
    end
  end
  local out = {}
  local seen = {}
  for _, r in pairs(PiNvim._progress) do
    if r.ended_at == nil and r.began_at ~= nil and r.began_at >= t0 and ids[r.client_id] ~= nil and not seen[r.client_id] then
      seen[r.client_id] = true
      table.insert(out, ids[r.client_id])
    end
  end
  return out
end

-- env 读取归一：`getenv` 未设置时返回 vim.NIL（userdata），`or fallback` 捕不到，
-- 直接参与拼接会报"attempt to concatenate a userdata value"、传给 tonumber 亦不稳。
local function env_str(name, fallback)
  local v = vim.fn.getenv(name)
  if type(v) == "string" and v ~= "" then
    return v
  end
  return fallback
end

local function env_num(name, fallback)
  local n = tonumber(env_str(name, ""))
  if n == nil then
    return fallback
  end
  return n
end

local SOCK_DIR = env_str("PI_NVIM_SOCK_DIR", "")
local IDLE_MS = env_num("PI_NVIM_IDLE_MS", 300000)
local PARENT_POLL_MS = env_num("PI_NVIM_PARENT_POLL_MS", 15000)
-- 启动／pull 预算回退（请求体恒带 TS 配置值，此处仅防旧请求缺字段；旧 env 名认作别名）。
local DEF_STARTUP_MS = env_num("PI_NVIM_STARTUP_MS", env_num("PI_NVIM_ATTACH_MS", 10000))
local DEF_DIAGNOSTIC_MS = env_num("PI_NVIM_DIAGNOSTIC_MS", env_num("PI_NVIM_DIAG_MS", 20000))
-- 调用级时间硬顶（防畸形请求把 daemon 挂住）：TS 侧已按窗口联合钳制并放大过窗口，
-- 此处只做兜底——各字段各自封顶，二者之和（240s）仍在硬顶窗口（默认 300s）内。
local STARTUP_CAP_MS = 120000
local DIAGNOSTIC_CAP_MS = 120000

-- 冻结名单前迟到 client 宽限（startup 预算内扣；宽限后才到的下轮调用见）
local LATE_ATTACH_GRACE_MS = 1000
-- -32002 就绪竞态重试等待上界（单次，pull 预算内扣）
local REINIT_WAIT_MS = 2000

local function sock_path(name)
  return SOCK_DIR .. "/" .. name
end

local function read_json_file(path)
  local lines = vim.fn.readfile(path)
  if #lines == 0 then
    return nil, "empty request file"
  end
  local ok, val = pcall(vim.fn.json_decode, table.concat(lines, "\n"))
  if not ok then
    return nil, "bad request json"
  end
  return val, nil
end

-- 结束标记＝结果文件本身：出现即完工（正常 per_file／异常 {error} 信封二选一）。
-- 原子写（tmp＋rename）：扩展侧以“文件存在”判完工，半写文件会造成部分读；
-- rename 保证要么没有、要么完整。唯一无文件的情形是 daemon 中途崩溃——
-- 那是扩展侧超时＋杀重建兜底的，不在此处处理。
local function write_json_file(path, val)
  local ok, encoded = pcall(vim.fn.json_encode, val)
  if not ok then
    encoded = '{"per_file":[],"total_ms":0,"error":"json encode failed"}'
  end
  local tmp = path .. ".tmp"
  vim.fn.writefile({ encoded }, tmp)
  os.rename(tmp, path)
end

local function write_error(res_path, msg, total_ms)
  write_json_file(res_path, { per_file = {}, total_ms = total_ms or 0, error = msg })
end

-- 有界停全部 clients（TTL／session 末；5s 无效转 :qa! 由调用方兜底）
local function stop_all_clients(bounded_ms)
  bounded_ms = bounded_ms or 5000
  for _, c in ipairs(vim.lsp.get_clients()) do
    if not c:is_stopped() then
      pcall(function()
        c:stop(true)
      end)
    end
  end
  vim.wait(bounded_ms, function()
    for _, c in ipairs(vim.lsp.get_clients()) do
      if not c:is_stopped() then
        return false
      end
    end
    return true
  end)
end

-- wipe 指定 buffer（写失败的除外，由调用方过滤）
local function wipe_buffers(bufnrs)
  for _, b in ipairs(bufnrs) do
    if vim.api.nvim_buf_is_valid(b) then
      pcall(vim.cmd, "bwipeout! " .. b)
    end
  end
end

-- wipe 全部文件 buffer（TTL 用；剩裸 nvim）
local function wipe_all_file_buffers()
  local out = {}
  for _, b in ipairs(vim.api.nvim_list_bufs()) do
    if vim.api.nvim_buf_is_valid(b) and vim.api.nvim_buf_get_name(b) ~= "" then
      table.insert(out, b)
    end
  end
  wipe_buffers(out)
end

-- 退出路径：删 socket＋ready＋daemon.pid＋daemon.log 后再删目录。
-- daemon.log 必须一并删：它是本进程自己的 stderr 重定向，漏删则目录恒非空、rmdir 必失败，
-- 每次会话泄漏一个 sockdir（兄弟 GC 只扫同 session，跨会话残留永不回收，实测已堆积）。
local function cleanup_sock_dir()
  if SOCK_DIR == "" then
    return
  end
  vim.fn.delete(sock_path("nvim.sock"))
  vim.fn.delete(sock_path("ready"))
  vim.fn.delete(sock_path("daemon.pid"))
  local log_path = env_str("PI_NVIM_LOG", "")
  if log_path ~= "" then
    vim.fn.delete(log_path)
  end
  -- 仅删空目录；在途 req/res 残留时失败即留给下次 GC
  vim.fn.delete(SOCK_DIR, "d")
end

local function quit_all()
  cleanup_sock_dir()
  vim.cmd("qa!")
end

-- 快照／识别器已删（pull 语义不再需要）：push 时代靠“attach 快照 vs 现状”识别 client
-- 中途变化；pull 直接对 client 对象发请求，client 中途死亡表现为请求错误，按失败记账即可。
-- `no_client` 只看冻结时有无 initialized client（零 client＝信息态，绝不判失败）。

local function json_or_str(val)
  local ok, js = pcall(vim.fn.json_encode, val)
  if ok and type(js) == "string" then
    return js
  end
  return tostring(val)
end

-- 本 buffer 已初始化 clients（LspAttach 在 initialize 握手完成后触发，故
-- initialized 即“可发 pull”，无需再等别的；50ms 轮询只是把事件量化，无盲区）。
local function initialized_clients(bufnr, method)
  if bufnr == nil or not vim.api.nvim_buf_is_valid(bufnr) then
    return {}
  end
  local opts = { bufnr = bufnr }
  if method ~= nil then
    opts.method = method
  end
  local out = {}
  for _, c in ipairs(vim.lsp.get_clients(opts)) do
    if c.initialized then
      table.insert(out, c)
    end
  end
  return out
end

-- 请求登记：记 id＋其 buffers＋abort 标记（abort 时精确释放本单资源）。
-- abort 收尾：wipe 登记 buffers（半成品未交付一律清；写失败残留同理——
-- 本次调用整体作废，重调重建），删登记，不写 res（TS 侧已回 partial，写了也是孤儿）。
local function reg_request(id)
  if id == nil then
    return
  end
  PiNvim._reqs[id] = { bufs = {}, aborted = false }
end

local function unreg_request(id)
  if id == nil then
    return
  end
  PiNvim._reqs[id] = nil
end

-- 该请求是否已被 abort（nil-id／未登记一律 false：等不到就是没被中断）
local function aborted(id)
  local rec = id ~= nil and PiNvim._reqs[id] or nil
  return rec ~= nil and rec.aborted == true
end

local function reg_bufs(id, entries)
  local rec = id ~= nil and PiNvim._reqs[id] or nil
  if rec == nil then
    return
  end
  for _, e in ipairs(entries) do
    if e.buf ~= nil then
      table.insert(rec.bufs, e.buf)
    end
  end
end

local function abort_cleanup(id)
  if id == nil then
    return
  end
  local rec = PiNvim._reqs[id]
  if rec ~= nil then
    for _, b in ipairs(rec.bufs) do
      if vim.api.nvim_buf_is_valid(b) then
        pcall(vim.api.nvim_buf_delete, b, { force = true })
      end
    end
  end
  unreg_request(id)
end

-- 打开一批文件，返回 { buf = bufnr }（edit 失败记 error）。
-- 存在性必须前置：`:edit` 对不存在的路径会新建空 buffer，LSP 会照常挂上并给空文件
-- 出诊断（下游守卫虽已查，但守卫与 daemon 之间文件可能被删，此处兜底）。
local function edit_batch(files)
  local out = {}
  for _, f in ipairs(files) do
    if vim.fn.filereadable(f) ~= 1 then
      table.insert(out, { file = f, buf = nil, edit_error = "file not found or not readable" })
    else
      local ok, err = pcall(vim.cmd.edit, vim.fn.fnameescape(f))
      if not ok then
        table.insert(out, { file = f, buf = nil, edit_error = tostring(err) })
      else
        table.insert(out, { file = f, buf = vim.api.nvim_get_current_buf(), edit_error = nil })
      end
    end
  end
  return out
end

-- 统一等各 root client 就绪（并发冷启动，批延迟＝最慢 root；有界超时即走）。
-- method 过滤：diagnose 传 nil（等任意 initialized client）；format 传
-- "textDocument/formatting”（formatter 常比诊断 client 慢，若只等“任一 client”
-- 就放行，门控会把“还没 attach”误判成 no-formatter，故按入口能力等）。
-- 注意：只保证“名单内”完整——冻结后才就绪的 client 本轮不在快照里，下轮调用自然包含
-- （名单外连“该有谁”都不可知，这是查询语义诚实的边界）。
local function wait_attach(entries, budget_ms, method, req_id)
  vim.wait(budget_ms, function()
    if PiNvim._shutdown or aborted(req_id) then
      return true
    end
    for _, e in ipairs(entries) do
      if e.buf ~= nil and vim.api.nvim_buf_is_valid(e.buf) then
        if #initialized_clients(e.buf, method) == 0 then
          return false
        end
      end
    end
    return true
  end, 50)
end

-- 纯格式化 client 识别（不当作诊断源）：只声明格式化类＋标准同步类能力者，
-- 不会发诊断。实测 oxfmt caps={documentFormattingProvider, textDocumentSync, workspace}
-- → 识别为纯格式化；lua_ls/gopls 等有 hover/completion 等一大票能力 → 不是。
-- 意义：避免每批为纯格式化 client 白等满 push 预算（实测 TS 批 +20s）。
-- 代价：若某纯格式化 server 真的 publish 诊断，会被忽略（极罕见，注释钉死此取舍）。
local FORMAT_ONLY_OK_CAPS = {
  documentFormattingProvider = true,
  documentRangeFormattingProvider = true,
  documentOnTypeFormattingProvider = true,
  textDocumentSync = true,
  workspace = true,
  experimental = true,
  positionEncoding = true,
}
local function is_formatter_only(c)
  local caps = c.server_capabilities or {}
  if caps.documentFormattingProvider == nil and caps.documentRangeFormattingProvider == nil then
    return false
  end
  for k, v in pairs(caps) do
    if v ~= nil and v ~= false and not FORMAT_ONLY_OK_CAPS[k] then
      return false
    end
  end
  return true
end

-- pull 快照与 push 存量合并（精确去重；两边是同一份 server 数据的两种看法）
local function merge_dedupe(dst, src)
  for _, d in ipairs(src) do
    local dup = false
    for _, e in ipairs(dst) do
      if e.line == d.line and e.col == d.col and e.severity == d.severity and e.source == d.source and e.message == d.message and e.client == d.client then
        dup = true
        break
      end
    end
    if not dup then
      table.insert(dst, d)
    end
  end
  sort_diags(dst)
end

-- push 回退静默收敛期（尽力而为的启发值，非确定性保证，见 wait_diagnostics）
local PUSH_QUIET = 1500
-- 最小观测窗（毫秒）：实测 gopls 先推空（~1.5s）后出 analyzer 波（~7.3s），
-- 首推即收会把真波漏掉（与 push 无终点标记同一根因）。故即使已满足，也至少观测
-- 这么久；有未结束 progress（busy）则继续延长到预算上限。env 可调（调小＝变快但可能漏）。
local PUSH_MIN_OBSERVE_MS = env_num("PI_NVIM_PUSH_MIN_OBSERVE_MS", 15000)

-- 目标单位是 buffer（不管后台 server 怎么起、怎么 attach）：两段节奏——
-- 启动段（等每个 buffer 有可用 client，批级一次等待）与诊断段（每 buffer 的 pull 请求
-- 与 push 观测并行，共用一份 diagnosticMs 总预算）。pull 一次性全部发出（回调写状态），
-- buffer 间彼此独立：总延迟＝最慢那个，而不是逐个相加。
local function plan_entry(entry)
  entry.pull = {}
  entry.push = { clients = {}, state = "pending" }
  local clients = initialized_clients(entry.buf, nil)
  if #clients == 0 then
    local attached = vim.lsp.get_clients({ bufnr = entry.buf })
    if #attached > 0 then
      local names = {}
      for _, c in ipairs(attached) do
        table.insert(names, c.name)
      end
      entry.skip_fail = "(" .. table.concat(names, ", ") .. ") initialization timed out"
    else
      entry.skip_reason = "no LSP client"
    end
    return
  end
  for _, c in ipairs(clients) do
    if c:supports_method("textDocument/diagnostic") then
      table.insert(entry.pull, { client = c, name = c.name, done = false })
    elseif not is_formatter_only(c) then
      table.insert(entry.push.clients, { id = c.id, name = c.name })
    end
  end
end

-- 异步发一个 pull（不阻塞）；回调写状态。client 中途死亡＝请求错误（按失败记账）。
local function issue_pull(p, buf, uri)
  p.done, p.ok, p.items, p.code, p.message = false, nil, nil, nil, nil
  local ok_send, send_err = pcall(function()
    local accepted = p.client:request("textDocument/diagnostic", { textDocument = { uri = uri } }, function(err, result)
      if err ~= nil then
        p.ok = false
        p.code = type(err) == "table" and err.code or nil
        p.message = type(err) == "table" and (err.message or vim.inspect(err)) or tostring(err)
      else
        p.ok = true
        p.items = (result and result.kind ~= "unchanged" and result.items) or {}
      end
      p.done = true
    end, buf)
    if not accepted then
      error("request not accepted (client stopped?)")
    end
  end)
  if not ok_send then
    p.ok, p.done, p.message = false, true, tostring(send_err)
  end
end

local function issue_all_pulls(entries)
  for _, e in ipairs(entries) do
    for _, p in ipairs(e.pull or {}) do
      issue_pull(p, e.buf, e.uri)
    end
  end
end

-- -32002（ServerNotInitialized）是 attach 与 initialized 之间的就绪竞态：等 500ms 重试一次。
local function sweep_pull_retries(entries, now)
  for _, e in ipairs(entries) do
    for _, p in ipairs(e.pull or {}) do
      if p.done and not p.ok and p.code == -32002 and not p.retried then
        p.retried = true
        p.retry_at = now + 500
      end
      if p.retry_at ~= nil and now >= p.retry_at then
        p.retry_at = nil
        issue_pull(p, e.buf, e.uri)
      end
    end
  end
end

local function pulls_settled(entries)
  for _, e in ipairs(entries) do
    for _, p in ipairs(e.pull or {}) do
      if not p.done then
        return false
      end
    end
  end
  return true
end

-- 诊断段单一等待循环：pull 回调与 push 观测并行，共用一份 diagnosticMs 总预算。
-- 时间基点是**诊断段起点 t_diag**（startup 段结束时刻）——两段节奏各自计时，互不吃预算；
-- t_req 只用于 busy 证据过滤（本请求以来仍未结束的 progress 才算“还在干活”）。
-- 退出：pull 全部 settle 且 push 结论落定；或到总预算上限（未完成者按超时/弱干净裁决）。
-- push 结论＝（全部满足＋静默＋过地板） 或 （从未发布＋过地板＋无 busy＝弱干净早收） 或 到上限。
local function wait_diagnostics(entries, t_diag, t_req, budget_ms, req_id)
  local deadline = t_diag + math.max(budget_ms, 1)
  local bufnrs = {}
  for _, e in ipairs(entries) do
    if e.buf ~= nil then
      table.insert(bufnrs, e.buf)
    end
  end
  local last_activity = nil
  local function scan_push(now_ts)
    local activity = false
    for _, e in ipairs(entries) do
      local push = e.push
      if push ~= nil and push.state == "pending" then
        local cur_hash = nil
        local all_settled = true
        local any_fresh = false
        for _, c in ipairs(push.clients) do
          local rec = PiNvim._publishes[tostring(c.id) .. "\0" .. e.uri]
          if rec == nil then
            all_settled = false
          elseif rec.at >= t_diag then
            any_fresh = true
          else
            -- 旧发布：内容未变且已静默够久（≥地板）⇒ 该次发布即当前内容的最终结论
            if cur_hash == nil then
              cur_hash = buf_content_hash(e.buf)
            end
            if rec.hash == nil or cur_hash == nil or rec.hash ~= cur_hash or (now_ts - rec.at) < PUSH_MIN_OBSERVE_MS then
              all_settled = false
            end
          end
        end
        if all_settled then
          push.state = any_fresh and "fresh" or "cached"
          if any_fresh then
            activity = true
          end
        end
      end
    end
    return activity
  end
  if scan_push(vim.uv.now()) then
    last_activity = t_diag
  end
  while true do
    local now = vim.uv.now()
    if PiNvim._shutdown or aborted(req_id) then
      return "aborted"
    end
    sweep_pull_retries(entries, now)
    local need_push = false
    local push_all = true
    local any_fresh = false
    for _, e in ipairs(entries) do
      local push = e.push
      if push ~= nil and #push.clients > 0 then
        need_push = true
        if push.state == "pending" then
          push_all = false
        elseif push.state == "fresh" then
          any_fresh = true
        end
      end
    end
    local push_done = true
    if need_push then
      local elapsed = now - t_diag
      local quiet = last_activity == nil or (now - last_activity) >= PUSH_QUIET
      local floor_ok = (not any_fresh) or elapsed >= PUSH_MIN_OBSERVE_MS
      if push_all and quiet and floor_ok then
        -- 全部落定（新鲜发布需过地板防迟到波；缓存命中不吃地板——内容哈希已证同源）
        push_done = true
      elseif quiet and elapsed >= PUSH_MIN_OBSERVE_MS and #busy_push_clients(bufnrs, t_req) == 0 then
        -- 无发布（或发布后长期静默）且无“还在干活”证据 → 早收（未落定者按弱干净裁决）
        push_done = true
      else
        push_done = false
      end
    end
    if pulls_settled(entries) and push_done then
      return "ok"
    end
    if now >= deadline then
      return "ok"
    end
    vim.wait(50)
    if scan_push(vim.uv.now()) then
      last_activity = vim.uv.now()
    end
  end
end

-- 组装一个文件的 entry：pull 结果＋push 裁决合并。
-- status 三值：success（检查完成；diags 空＝干净）／failed（未完成，原因在 message）／
-- skipped（未执行）。弱干净只写 note（details），不进 content。
local function assemble_entry(e, t_req, t_diag)
  local entry = { file = e.file, diags = {}, ms = vim.uv.now() - t_req }
  if e.edit_error ~= nil then
    entry.status, entry.message = "failed", e.edit_error
    return entry
  end
  if e.buf == nil or not vim.api.nvim_buf_is_valid(e.buf) then
    entry.status, entry.message = "failed", "buffer lost mid-request"
    return entry
  end
  if e.skip_reason ~= nil then
    entry.status, entry.message = "skipped", e.skip_reason
    return entry
  end
  if e.skip_fail ~= nil then
    entry.status, entry.message = "failed", e.skip_fail
    return entry
  end
  local failures = {}
  for _, p in ipairs(e.pull or {}) do
    if p.ok then
      for _, d in ipairs(map_lsp_diags(p.items, p.name)) do
        table.insert(entry.diags, d)
      end
    elseif not p.done then
      table.insert(failures, "(" .. p.name .. ") diagnostics timed out")
    elseif p.code == -32002 then
      table.insert(failures, "(" .. p.name .. ") server not initialized")
    else
      table.insert(failures, "(" .. p.name .. ") " .. (p.message ~= nil and p.message ~= "" and p.message or "unknown error"))
    end
  end
  local weak_clean = false
  local push = e.push
  -- 观测是否够久（诊断段起点 t_diag 起算）：deadline 早于地板时，"新鲜发布"也不足为据
  local observed_enough = t_diag == nil or (vim.uv.now() - t_diag) >= PUSH_MIN_OBSERVE_MS
  if push ~= nil and #push.clients > 0 then
    local pending_names = {}
    for _, c in ipairs(push.clients) do
      local rec = PiNvim._publishes[tostring(c.id) .. "\0" .. e.uri]
      if rec ~= nil and rec.name == c.name and ((push.state == "cached") or (push.state == "fresh" and observed_enough)) then
        -- 数据直接来自发布记录（wipe 后仍有效；client 归属由记录自带）
        merge_dedupe(entry.diags, rec.diags)
      elseif rec ~= nil and rec.at >= t_req then
        -- 记录存在但观测不足（新鲜发布 + 预算比地板短）：数据照收（partial），但按未完成记账
        merge_dedupe(entry.diags, rec.diags)
        table.insert(pending_names, c.name)
      else
        table.insert(pending_names, c.name)
      end
    end
    if #pending_names > 0 then
      local busy = busy_push_clients({ e.buf }, t_req)
      if #busy > 0 then
        table.insert(failures, "(" .. table.concat(busy, ", ") .. ") diagnostics timed out")
      elseif t_diag ~= nil and (vim.uv.now() - t_diag) >= PUSH_MIN_OBSERVE_MS then
        -- 观测满地板且服务器闲着 → 弱干净（有经验的“无事”）；
        -- 没观测满（预算配得比地板还短）→ 不能判干净，按超时失败（诚实性优先）
        weak_clean = true
      else
        table.insert(failures, "(" .. table.concat(pending_names, ", ") .. ") diagnostics timed out")
      end
    end
  end
  sort_diags(entry.diags)
  if #failures > 0 then
    entry.status, entry.message = "failed", table.concat(failures, "; ")
  else
    entry.status = "success"
    if weak_clean and #entry.diags == 0 then
      entry.note = "best-effort clean: no push published, server idle"
    end
  end
  return entry
end

local function buf_lines(bufnr)
  return vim.api.nvim_buf_get_lines(bufnr, 0, -1, false)
end

-- 内容是否有变化（布尔，纯函数）：行数不同或任一行不同即变。
-- formatted 只看成败，不做行级 diff——位置比较会把"前部插入"误报成后续每一行都改了
-- （顶部插 1 行即虚报全文件），数字对模型无意义，故只留布尔。
local function content_changed(before, after)
  if #before ~= #after then
    return true
  end
  for i = 1, #before do
    if before[i] ~= after[i] then
      return true
    end
  end
  return false
end

-- 确保当前 buffer＝目标（:w 恒写当前 buffer，错文件写入无报错，必须前置校验）
local function ensure_current(entry)
  if entry.buf == nil or not vim.api.nvim_buf_is_valid(entry.buf) then
    return false
  end
  -- 切过去再校验（批内串行，上一文件处理完当前 buffer 即上一目标）
  pcall(vim.api.nvim_set_current_buf, entry.buf)
  return vim.api.nvim_get_current_buf() == entry.buf
    and vim.api.nvim_buf_get_name(entry.buf) == entry.file
end

-- 单文件写盘＝模拟用户按 :w（只管门控＋写盘＋内容比较；不等待不收诊断——
-- per-file settle 会把“还没开始（暂 0）”当成“真干净”，诊断由批级 settle 后统一 collect）。
-- 返回写盘元信息（_buf/_keep 为批组装用，组装后剥除再落结果文件）。
local function format_write(entry)
  local t0 = vim.uv.now()
  local finish = function(result)
    result.ms = vim.uv.now() - t0
    return result
  end
  if entry.edit_error ~= nil then
    return finish({
      file = entry.file,
      formatted = false,
      reason = "format-error",
      error = entry.edit_error,
    })
  end
  if not ensure_current(entry) then
    return finish({
      file = entry.file,
      formatted = false,
      reason = "format-error",
      _buf = entry.buf,
    })
  end
  local buf = entry.buf
  -- 门控：无 formatting client 记 no-formatter（buf.format 无 client 仅 notify，必须显式分支）
  local formatters = vim.lsp.get_clients({ bufnr = buf, method = "textDocument/formatting" })
  if #formatters == 0 then
    return finish({
      file = entry.file,
      formatted = false,
      reason = "no-formatter",
      _buf = buf,
    })
  end
  local before = buf_lines(buf)
  -- 恒 `:w`：未改 buffer 的 `:w` 同样走 BufWritePre formatter 管道（实测 ruff 生效），
  -- 跳过即等于禁用格式化；与用户亲手按 `:w` 完全一致（含 mtime 语义），不做免抖动特例。
  -- 普通 `:w`（带用户 autocmd，与交互完全一致；桥接不再显式调 format，
  -- 不用 noautocmd，不选边——选边是用户配置的事）
  local ok = pcall(vim.cmd, "write")
  if not ok then
    -- :w 失败留现场不 wipe（内存≠磁盘，转人工），下次碰到报残留
    return finish({
      file = entry.file,
      formatted = false,
      reason = "write-error",
      _buf = buf,
      _keep = true,
    })
  end
  local after = buf_lines(buf)
  local changed = content_changed(before, after)
  return finish({
    file = entry.file,
    formatted = changed,
    reason = changed and "ok" or "unchanged",
    _buf = buf,
  })
end

-- 请求包装：立 _busy（TTL 到点忙则跳过重排）＋刷新 idle 时钟＋shutdown 短路
local function process(req_path, res_path, fn)
  if PiNvim._shutdown then
    write_error(res_path, "daemon shutting down", 0)
    return
  end
  PiNvim._busy = true
  PiNvim._last_req_ms = vim.uv.now()
  local t0 = vim.uv.now()
  local ok, err = pcall(fn, req_path, res_path, t0)
  PiNvim._busy = false
  PiNvim._last_req_ms = vim.uv.now()
  if not ok then
    -- Lua 侧异常不静默：写 error 结果（TS 侧读后抛错，不会误报 clean）
    write_error(res_path, "bridge error: " .. tostring(err), vim.uv.now() - t0)
  end
end

function PiNvim.diagnose(req_path, res_path)
  process(req_path, res_path, function(rp, op, t0)
    local req, err = read_json_file(rp)
    if req == nil then
      write_error(op, "bad request: " .. tostring(err), vim.uv.now() - t0)
      return
    end
    local files = req.files or {}
    local startup_ms = math.min(math.max(tonumber(req.startupMs) or DEF_STARTUP_MS, 0), STARTUP_CAP_MS)
    local diagnostic_ms = math.min(math.max(tonumber(req.diagnosticMs) or DEF_DIAGNOSTIC_MS, 1000), DIAGNOSTIC_CAP_MS)
    local entries = edit_batch(files)
    reg_request(req.id)
    reg_bufs(req.id, entries)
    -- 启动等待（成功提前走，到点按文件裁决；LspAttach 在握手完成后触发，
    -- 故“有 initialized client”即“可发 pull”，无需再等别的）
    wait_attach(entries, startup_ms, nil, req.id)
    if aborted(req.id) then
      abort_cleanup(req.id)
      return
    end
    -- 冻结前宽限（startup 预算内扣）：捡启动慢一拍的 client；宽限后才到的下轮调用见
    local grace = math.max(math.min(LATE_ATTACH_GRACE_MS, startup_ms - (vim.uv.now() - t0)), 0)
    if grace > 0 then
      vim.wait(grace, function()
        return PiNvim._shutdown or aborted(req_id)
      end, 50)
    end
    if aborted(req.id) then
      abort_cleanup(req.id)
      return
    end
    -- 计划（per-client 二选一：pull／push／纯格式化排除）＋一次性发出全部 pull（异步）
    for _, e in ipairs(entries) do
      if e.edit_error == nil and e.buf ~= nil and vim.api.nvim_buf_is_valid(e.buf) then
        e.uri = vim.uri_from_bufnr(e.buf)
        plan_entry(e)
      end
    end
    issue_all_pulls(entries)
    -- 诊断段单一等待（pull 并行＋push 观测，共用一份 diagnosticMs 总预算；自诊断段起点计时）
    local t_diag = vim.uv.now()
    if wait_diagnostics(entries, t_diag, t0, diagnostic_ms, req.id) == "aborted" then
      abort_cleanup(req.id)
      return
    end
    local per_file = {}
    local wipe = {}
    for _, e in ipairs(entries) do
      local ok, entry = pcall(assemble_entry, e, t0, t_diag)
      if not ok then
        entry = { file = e.file, status = "failed", message = "bridge error: " .. tostring(entry), diags = {}, ms = 0 }
      end
      table.insert(per_file, entry)
      if e.buf ~= nil then
        table.insert(wipe, e.buf)
      end
    end
    -- 批末只 wipe 本批 buffer，不停任何 client（server 留温整 session）
    wipe_buffers(wipe)
    write_json_file(op, { per_file = per_file, total_ms = vim.uv.now() - t0 })
    unreg_request(req.id)
  end)
end

function PiNvim.format(req_path, res_path)
  process(req_path, res_path, function(rp, op, t0)
    local req, err = read_json_file(rp)
    if req == nil then
      write_error(op, "bad request: " .. tostring(err), vim.uv.now() - t0)
      return
    end
    local files = req.files or {}
    local startup_ms = math.min(math.max(tonumber(req.startupMs) or DEF_STARTUP_MS, 0), STARTUP_CAP_MS)
    local diagnostic_ms = math.min(math.max(tonumber(req.diagnosticMs) or DEF_DIAGNOSTIC_MS, 1000), DIAGNOSTIC_CAP_MS)
    local entries = edit_batch(files)
    -- 登记必须早于 wait_attach（与 diagnose 对齐）：abort 认领靠 `_reqs[id]` 已在册。
    -- 晚登记则启动窗口内到达的 abort 被丢弃，format 会在用户已中断后照常写盘
    -- （TS 侧却已回 partial，磁盘与模型认知相悖）。
    reg_request(req.id)
    reg_bufs(req.id, entries)
    -- 先全 edit 再统一等 attach（并发冷启动）；按 formatting 能力等，防误判 no-formatter
    wait_attach(entries, startup_ms, "textDocument/formatting", req.id)
    -- 先逐文件写盘（不管诊断），再逐文件 pull 写后诊断（查询语义，无需 settle）
    local pending = {}
    for _, e in ipairs(entries) do
      if aborted(req.id) then
        break
      end
      table.insert(pending, format_write(e))
    end
    if aborted(req.id) then
      abort_cleanup(req.id)
      return
    end
    -- 诊断段（format 只 pull，不赌 push）：逐文件计划＋一次性发出全部 pull，单循环等待
    local plans = {}
    local plan_of = {}
    for _, r in ipairs(pending) do
      if r.error == nil and r._buf ~= nil and vim.api.nvim_buf_is_valid(r._buf) then
        local plan = { buf = r._buf, uri = vim.uri_from_bufnr(r._buf) }
        plan_entry(plan)
        plan_of[r] = plan
        table.insert(plans, plan)
        for _, pp in ipairs(plan.pull) do
          issue_pull(pp, plan.buf, plan.uri)
        end
      end
    end
    local deadline = t0 + math.max(diagnostic_ms, 1)
    while true do
      local now = vim.uv.now()
      if PiNvim._shutdown or aborted(req.id) then
        abort_cleanup(req.id)
        return
      end
      sweep_pull_retries(plans, now)
      if pulls_settled(plans) or now >= deadline then
        break
      end
      vim.wait(50)
    end
    local per_file = {}
    local wipe = {}
    for _, r in ipairs(pending) do
      local ok, err = pcall(function()
        local plan = plan_of[r]
        if plan ~= nil then
          local fails = {}
          for _, pp in ipairs(plan.pull) do
            if pp.ok then
              for _, d in ipairs(map_lsp_diags(pp.items, pp.name)) do
                table.insert(r.diags, d)
              end
            elseif not pp.done then
              table.insert(fails, "(" .. pp.name .. ") diagnostics timed out")
            elseif pp.code == -32002 then
              table.insert(fails, "(" .. pp.name .. ") server not initialized")
            else
              table.insert(fails, "(" .. pp.name .. ") " .. (pp.message ~= nil and pp.message ~= "" and pp.message or "unknown error"))
            end
          end
          if #plan.push.clients > 0 then
            local names = {}
            for _, c in ipairs(plan.push.clients) do
              table.insert(names, c.name)
            end
            table.insert(fails, "no pull support: " .. table.concat(names, ", "))
          end
          if plan.skip_reason ~= nil then
            table.insert(fails, plan.skip_reason)
          elseif plan.skip_fail ~= nil then
            table.insert(fails, plan.skip_fail)
          end
          if #fails > 0 then
            r.note = "post-write diagnostics incomplete (" .. table.concat(fails, "; ") .. ")"
          end
        end
        r.diags = r.diags or {}
      end)
      if not ok then
        r.raw = json_or_str({ lua_error = tostring(err) })
        r.note = "bridge error"
        r.diags = r.diags or {}
        r._raw = true
      end
      local keep = r._keep
      local buf = r._buf
      local skip_wipe = r._raw == true
      r._keep = nil
      r._buf = nil
      r._raw = nil
      table.insert(per_file, r)
      -- 写失败／不可识别留现场不 wipe，下次碰到报残留；其余批末 wipe
      if not keep and not skip_wipe and buf ~= nil then
        table.insert(wipe, buf)
      end
    end
    wipe_buffers(wipe)
    write_json_file(op, { per_file = per_file, total_ms = vim.uv.now() - t0 })
    unreg_request(req.id)
  end)
end

-- session 末／pi 侧 fire-and-forget：先立 flag（后续 process 直接回错），
-- 再有界停 clients＋wipe，最后 :qa!（stop 无效同样走 :qa! 兜底）
--- abort(id)：带证上门。只有仍在册（未 unreg）的请求才认领，过期/对不上直接丢弃。
--- 每请求标记，绝不置全局（见文件头 P2-4 注释：全局会让孤儿请求误伤新请求的 buffer）。
--- TS 侧 signal 触发后 fire-and-forget 发送，不等回执。
function PiNvim.abort(id)
  local rec = id ~= nil and PiNvim._reqs[id] or nil
  if rec ~= nil then
    rec.aborted = true
  end
end

function PiNvim.begin_shutdown()
  PiNvim._shutdown = true
  stop_all_clients(5000)
  wipe_all_file_buffers()
  quit_all()
end

-- 空闲 TTL：idleMs 无请求且无在途 _busy 才停 clients＋wipe（剩裸 nvim），到点忙则跳过重排
local function idle_check()
  if PiNvim._shutdown or PiNvim._busy then
    return
  end
  if vim.uv.now() - PiNvim._last_req_ms >= IDLE_MS then
    stop_all_clients(5000)
    wipe_all_file_buffers()
    PiNvim._last_req_ms = vim.uv.now()
  end
end

-- 父死亡探测：pi 没了→停 clients＋wipe＋删 socket 目录→:qa!
local function parent_check()
  if PiNvim._shutdown then
    return
  end
  local ppid = vim.uv.os_getppid()
  -- ppid<=1 说明已被 reparent（父已死），kill(1,0) 常为真故单独判死
  local dead = ppid == nil or ppid <= 1 or vim.uv.kill(ppid, 0) ~= 0
  if dead then
    PiNvim._shutdown = true
    stop_all_clients(5000)
    wipe_all_file_buffers()
    quit_all()
  end
end

-- 启动：写 daemon.pid，立两定时器，ready 标记最后写（ensure 以 ready＋connect 双条件为准）
local function auto_setup()
  if SOCK_DIR == "" then
    return
  end
  vim.fn.writefile({ tostring(vim.fn.getpid()) }, sock_path("daemon.pid"))
  local idle_timer = vim.uv.new_timer()
  if idle_timer then
    idle_timer:start(IDLE_MS, IDLE_MS, vim.schedule_wrap(idle_check))
  end
  local parent_timer = vim.uv.new_timer()
  if parent_timer then
    parent_timer:start(PARENT_POLL_MS, PARENT_POLL_MS, vim.schedule_wrap(parent_check))
  end
  vim.fn.writefile({ "ready" }, sock_path("ready"))
end

_G.PiNvim = PiNvim
auto_setup()
-- progress 常驻记录与 auto_setup 解耦：无 SOCK_DIR 的加载校验路径也装得上
-- （pcall 内部兜底，古董 nvim 无声降级）；真正的 daemon 启动时 auto_setup 照常跑。
setup_progress_watch()
setup_publish_watch()

return PiNvim
