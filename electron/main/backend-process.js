"use strict";

const { spawn } = require("node:child_process");

/**
 * 启动内部 Python worker。任务授权由调用方按运行模式决定，内部模式不要求官网租约。
 * spawnImpl 可注入，便于在不创建真实进程的情况下验证完整启动参数。
 */
function spawnBackendProcess({ command, args, cwd, env, spawnImpl = spawn }) {
  if (!command) throw new TypeError("缺少 worker 命令");
  if (!Array.isArray(args)) throw new TypeError("worker 参数必须是数组");
  if (typeof spawnImpl !== "function") throw new TypeError("spawnImpl 必须是函数");
  return spawnImpl(command, args, { cwd, env, windowsHide: true });
}

module.exports = { spawnBackendProcess };
