-- @inobit/pi-nvim — 常驻 daemon 内桥接（lua/bridge.lua，方案 §五）。
--
-- 双入口（经 --remote-send 按键式 `:lua PiNvim.<fn>('<req>','<res>')` 调用）：
-- - `PiNvim.diagnose(req, res)`：只读诊断，绝不写盘。
-- - `PiNvim.format(req, res)`：逐文件模拟用户按 `:w`（普通 `:w`，用户 autocmd 即
--   formatter 管道；桥接不显式调 buf.format、不用 noautocmd、不选边）。
-- 两定时器（异常兜底，常规管理靠 pi 侧事件）：
-- - 空闲 TTL：idleMs 无请求且无在途任务 → 有界停全部 clients＋wipe 全部文件 buffer
--   （剩裸 nvim，~30MB；下次调用秒级重建）。
-- - 父探测：parentPollMs 轮询 vim.uv.os_getppid() 存活，死则停＋wipe＋删 socket 目录＋`:qa!`。
--
-- 请求文件：{files=[...], attachMs, diagMs, formatMs}；结果文件：{per_file=[...], total_ms}。

local PiNvim = {}

-- 状态（先立 flag：begin_shutdown 后 process 直接回错，见 Correctness-3）
PiNvim._shutdown = false
PiNvim._busy = false
PiNvim._last_req_ms = vim.uv.now()

local SOCK_DIR = vim.fn.getenv("PI_NVIM_SOCK_DIR") or ""
local IDLE_MS = tonumber(vim.fn.getenv("PI_NVIM_IDLE_MS")) or 300000
local PARENT_POLL_MS = tonumber(vim.fn.getenv("PI_NVIM_PARENT_POLL_MS")) or 15000
local DEF_ATTACH_MS = tonumber(vim.fn.getenv("PI_NVIM_ATTACH_MS")) or 20000
local DEF_DIAG_MS = tonumber(vim.fn.getenv("PI_NVIM_DIAG_MS")) or 10000
local DEF_FORMAT_MS = tonumber(vim.fn.getenv("PI_NVIM_FORMAT_MS")) or 20000

-- 批级诊断落定参数（P0 校准依据：本地 headless 实测冷启动 edit→首诊断
-- ts ~2.5s（3 次：2475/2477/2505ms，attach 后 ~2.0s）、go ~0.6s、py ~0.3s；
-- ts 最慢，故最小时间线取 3s（覆盖 ts 冷启动＋余量），静默期 0.5s 防诊断分波到达）。
local MIN_SETTLE_MS = tonumber(vim.fn.getenv("PI_NVIM_MIN_SETTLE_MS")) or 3000
local QUIET_MS = 500

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

local function write_json_file(path, val)
  local ok, encoded = pcall(vim.fn.json_encode, val)
  if not ok then
    encoded = '{"per_file":[],"total_ms":0,"error":"json encode failed"}'
  end
  vim.fn.writefile({ encoded }, path)
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

-- 退出路径：删 socket＋ready＋daemon.pid 后再删目录（非空 rmdir 必失败，残留由 GC 收）
local function cleanup_sock_dir()
  if SOCK_DIR == "" then
    return
  end
  vim.fn.delete(sock_path("nvim.sock"))
  vim.fn.delete(sock_path("ready"))
  vim.fn.delete(sock_path("daemon.pid"))
  -- 仅删空目录；在途 req/res 残留时失败即留给下次 GC
  vim.fn.delete(SOCK_DIR, "d")
end

local function quit_all()
  cleanup_sock_dir()
  vim.cmd("qa!")
end

-- 识别器：正常态只认“现至少一个已初始化 client”；快照有过人、现无人或未初始化
-- 即不可识别，走 raw 透传（原文＋note），永不记 clean、永不编造 reason。
local function snapshot_clients(bufnr)
  if bufnr == nil or not vim.api.nvim_buf_is_valid(bufnr) then
    return nil
  end
  local out = {}
  for _, c in ipairs(vim.lsp.get_clients({ bufnr = bufnr })) do
    table.insert(out, { id = c.id, name = c.name, initialized = c.initialized == true })
  end
  return out
end

local function json_or_str(val)
  local ok, js = pcall(vim.fn.json_encode, val)
  if ok and type(js) == "string" then
    return js
  end
  return tostring(val)
end

local function recognize(bufnr, snap)
  local cur = snapshot_clients(bufnr) or {}
  local live = 0
  for _, c in ipairs(cur) do
    if c.initialized then
      live = live + 1
    end
  end
  if live > 0 then
    return "normal", cur
  end
  if snap ~= nil and #snap > 0 then
    return "raw", cur
  end
  return "noclient", cur
end

-- 打开一批文件，返回 { buf = bufnr }（edit 失败记 error）
local function edit_batch(files)
  local out = {}
  for _, f in ipairs(files) do
    local ok, err = pcall(vim.cmd.edit, vim.fn.fnameescape(f))
    if not ok then
      table.insert(out, { file = f, buf = nil, edit_error = tostring(err) })
    else
      table.insert(out, { file = f, buf = vim.api.nvim_get_current_buf(), edit_error = nil })
    end
  end
  return out
end

-- 统一等各 root client attach（并发冷启动，批延迟＝最慢 root；有界超时即走）。
-- method 过滤：diagnose 等任意 client；format 等 formatting 能力 client——
-- formatter（none-ls/ruff 等）常比诊断 client 慢，若只等“任一 client”（如 ty）
-- 就放行，门控会把“还没 attach”误判成 no-formatter（冒烟复现），故按入口能力等。
local function wait_attach(entries, budget_ms, method)
  -- 阶段一：等任一 client 到达（保冷启动正确性；diagnose 到此即返）
  vim.wait(budget_ms, function()
    if PiNvim._shutdown then
      return true
    end
    for _, e in ipairs(entries) do
      if e.buf ~= nil and vim.api.nvim_buf_is_valid(e.buf) then
        if #vim.lsp.get_clients({ bufnr = e.buf }) == 0 then
          return false
        end
      end
    end
    return true
  end)
  if method == nil then
    return
  end
  -- 阶段二：有 client 但无目标能力 client 的条目二次有界等待（慢 formatter 防误判
  -- no-formatter；上界 min(budget,5s），无 formatter 文件不再付满整档预算）
  vim.wait(math.min(budget_ms, 5000), function()
    if PiNvim._shutdown then
      return true
    end
    for _, e in ipairs(entries) do
      if e.buf ~= nil and vim.api.nvim_buf_is_valid(e.buf) then
        if #vim.lsp.get_clients({ bufnr = e.buf }) > 0
          and #vim.lsp.get_clients({ bufnr = e.buf, method = method }) == 0 then
          return false
        end
      end
    end
    return true
  end)
end

local function diag_counts(bufnrs)
  local out = {}
  for _, b in ipairs(bufnrs) do
    if vim.api.nvim_buf_is_valid(b) then
      out[b] = #vim.diagnostic.get(b)
    else
      out[b] = -1
    end
  end
  return out
end

local function counts_equal(a, b)
  for k, v in pairs(a) do
    if b[k] ~= v then
      return false
    end
  end
  return true
end

-- 批级诊断落定（push/pull 兼容）：attach 全齐后，对整批 buffer 只做一次等待。
-- 语义：有新诊断到达即续（last_change 重置）；无新诊断持续 QUIET_MS 且已过
-- 最小时间线 MIN_SETTLE_MS 才收；硬上界 budget（diagMs，per-request 覆盖保留）。
-- 背景（P0）：旧逻辑“计数连续两次采样不变即返”把“还没开始（暂 0）”当成“真干净”——
-- ts 冷启动 attach 后 ~2s 才出首诊断，首调必 miss。全零真干净文件多付
-- MIN_SETTLE_MS＋QUIET_MS（~3.5s），不付满 budget；慢诊断按到达即续，最坏延迟有界。
-- 注意：diagMs 若小于 MIN_SETTLE_MS，最小线永不到，按 budget 到期返回（budget 恒为上界）。
local function wait_diag_settled(bufnrs, budget_ms)
  if #bufnrs == 0 then
    return
  end
  local budget = budget_ms or DEF_DIAG_MS
  local start = vim.uv.now()
  local last = diag_counts(bufnrs)
  local last_change = start
  while true do
    if PiNvim._shutdown then
      return
    end
    local now = vim.uv.now()
    if now - start >= budget then
      return
    end
    if now - start >= MIN_SETTLE_MS and now - last_change >= QUIET_MS then
      return
    end
    vim.wait(100)
    local cur = diag_counts(bufnrs)
    if not counts_equal(cur, last) then
      last = cur
      last_change = vim.uv.now()
    end
  end
end

-- vim.diagnostic → 结果 shape（诊断全量搬运，不含文件内容；severity 优先排序：
-- error→warning→info→hint 再按行列，阅读优先级，非截断服务——诊断本就不截断）
local function collect_diags(bufnr)
  local out = {}
  for _, d in ipairs(vim.diagnostic.get(bufnr)) do
    table.insert(out, {
      line = (d.lnum or 0) + 1,
      col = (d.col or 0) + 1,
      severity = d.severity or 4,
      source = d.source or "lsp",
      message = d.message or "",
    })
  end
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

local function buf_lines(bufnr)
  return vim.api.nvim_buf_get_lines(bufnr, 0, -1, false)
end

local function count_changed(before, after)
  local n = 0
  local common = math.min(#before, #after)
  n = n + math.abs(#before - #after)
  for i = 1, common do
    if before[i] ~= after[i] then
      n = n + 1
    end
  end
  return n
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
      changed_lines = 0,
      error = entry.edit_error,
    })
  end
  if not ensure_current(entry) then
    return finish({
      file = entry.file,
      formatted = false,
      reason = "format-error",
      changed_lines = 0,
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
      changed_lines = 0,
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
    local after = buf_lines(buf)
    return finish({
      file = entry.file,
      formatted = false,
      reason = "write-error",
      changed_lines = count_changed(before, after),
      _buf = buf,
      _keep = true,
    })
  end
  local after = buf_lines(buf)
  local changed = count_changed(before, after)
  return finish({
    file = entry.file,
    formatted = changed > 0,
    reason = changed > 0 and "ok" or "unchanged",
    changed_lines = changed,
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
    local attach_ms = req.attachMs or DEF_ATTACH_MS
    local diag_ms = req.diagMs or DEF_DIAG_MS
    local entries = edit_batch(files)
    wait_attach(entries, attach_ms)
    for _, e in ipairs(entries) do
      e.snap = snapshot_clients(e.buf)
    end
    -- 批级落定（push/pull 兼容）：冷启动 attach 后诊断异步到达，不等即大概率空结果；
    -- 整批 buffer 只做一次 settle 等待（有新诊断到达即续，无新诊断持续 QUIET_MS 且过
    -- 最小时间线 MIN_SETTLE_MS 才收），然后逐文件直接 collect（diagnose/format 同路径）。
    local settle = {}
    for _, e in ipairs(entries) do
      if e.buf ~= nil and vim.api.nvim_buf_is_valid(e.buf) then
        table.insert(settle, e.buf)
      end
    end
    wait_diag_settled(settle, diag_ms)
    local per_file = {}
    local wipe = {}
    for _, e in ipairs(entries) do
      local ok, out = pcall(function()
        if e.edit_error ~= nil then
          return { entry = { file = e.file, diags = {}, ms = 0, error = e.edit_error }, wipe = false }
        end
        local verdict = recognize(e.buf, e.snap)
        if verdict == "raw" then
          return {
            entry = {
              file = e.file,
              raw = json_or_str({ at_attach = e.snap, note = "lsp client(s) changed mid-request" }),
              note = "lsp client(s) changed mid-request",
              diags = {},
              ms = vim.uv.now() - t0,
            },
            wipe = false,
          }
        end
        if verdict == "noclient" then
          -- 无 client 文件记 diags:[]＋no_client:true，绝不写盘
          return { entry = { file = e.file, diags = {}, ms = vim.uv.now() - t0, no_client = true }, wipe = true }
        end
        return { entry = { file = e.file, diags = collect_diags(e.buf), ms = vim.uv.now() - t0 }, wipe = true }
      end)
      if not ok then
        table.insert(per_file, {
          file = e.file,
          raw = json_or_str({ lua_error = tostring(out) }),
          note = "bridge error",
          diags = {},
          ms = 0,
        })
      else
        table.insert(per_file, out.entry)
        if out.wipe and e.buf ~= nil then
          table.insert(wipe, e.buf)
        end
      end
    end
    -- 批末只 wipe 本批 buffer，不停任何 client（server 留温整 session）
    wipe_buffers(wipe)
    write_json_file(op, { per_file = per_file, total_ms = vim.uv.now() - t0 })
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
    local attach_ms = req.attachMs or DEF_ATTACH_MS
    local diag_ms = req.diagMs or DEF_DIAG_MS
    local entries = edit_batch(files)
    -- 先全 edit 再统一等 attach（并发冷启动）；按 formatting 能力等，防误判 no-formatter
    wait_attach(entries, attach_ms, "textDocument/formatting")
    for _, e in ipairs(entries) do
      e.snap = snapshot_clients(e.buf)
    end
    -- 先逐文件写盘（不管诊断），再整批只做一次 settle，最后逐文件直接 collect
    -- （diagnose/format 同走批级落定路径；per-file settle 已删）
    local pending = {}
    local snap_by_file = {}
    for _, e in ipairs(entries) do
      snap_by_file[e.file] = e.snap
      table.insert(pending, format_write(e))
    end
    local settle = {}
    for _, r in ipairs(pending) do
      if r._buf ~= nil and vim.api.nvim_buf_is_valid(r._buf) then
        table.insert(settle, r._buf)
      end
    end
    wait_diag_settled(settle, diag_ms)
    local per_file = {}
    local wipe = {}
    for _, r in ipairs(pending) do
      local ok, err = pcall(function()
        if r.error ~= nil then
          return
        end
        if r._buf ~= nil and vim.api.nvim_buf_is_valid(r._buf) then
          local verdict = recognize(r._buf, snap_by_file[r.file])
          if verdict == "raw" then
            r.raw = json_or_str({ at_attach = snap_by_file[r.file], note = "lsp client(s) changed mid-request" })
            r.note = "lsp client(s) changed mid-request"
            r.diags = r.diags or {}
            r._raw = true
            return
          end
          r.diags = collect_diags(r._buf)
          if verdict == "noclient" then
            r.no_client = true
          end
        else
          r.diags = r.diags or {}
        end
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
  end)
end

-- session 末／pi 侧 fire-and-forget：先立 flag（后续 process 直接回错），
-- 再有界停 clients＋wipe，最后 :qa!（stop 无效同样走 :qa! 兜底）
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

return PiNvim
