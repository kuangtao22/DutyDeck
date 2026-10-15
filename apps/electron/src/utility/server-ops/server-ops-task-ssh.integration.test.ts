import { expect, test } from 'bun:test'
import { Client, Server } from 'ssh2'
import type { ClientChannel } from 'ssh2'
import type { AddressInfo } from 'node:net'
import type { ServerOpsAuditAppendInput, ServerOpsTaskIdentity, ServerOpsTaskReadResult } from '@proma/shared'
import { ServerOpsTaskRuntimeController } from '../server-ops-task-runtime'
import { ServerOpsTaskService } from '../../main/lib/server-ops/server-ops-task-service'
import type { ServerOpsTaskServiceDependencies } from '../../main/lib/server-ops/server-ops-task-service'
import { createServerOpsSshFixtureHostKey } from './server-ops-sftp-fixture'

/** 等待真实通道返回目标回显；事件驱动并在超时、成功和错误后解除监听。 */
function waitForEcho(channel: ClientChannel, text: string, send: string): Promise<string> {
  return new Promise((resolve, reject) => {
    /** 手动终端只保留本次探测的短回显。 */
    let output = ''
    const cleanup = () => { clearTimeout(timer); channel.off('data', onData); channel.off('error', onError) }
    const onData = (data: Buffer) => { output += data.toString(); if (output.includes(text)) { cleanup(); resolve(output) } }
    const onError = (error: Error) => { cleanup(); reject(error) }
    const timer = setTimeout(() => { cleanup(); reject(new Error('SSH_FIXTURE_ECHO_TIMEOUT')) }, 3_000)
    channel.on('data', onData); channel.once('error', onError); channel.write(send)
  })
}

/** 真实 loopback 连接复用：不访问外部网络、系统 SSH 或任何生产凭据。 */
test('Given 已认证且手动终端打开 When 独立PTY任务等待用户输入并退出 Then 单次认证与两通道隔离成立', async () => {
  /** 仅本测试进程知道的虚构凭据，绝不读取真实业务配置。 */
  const loginPassword = 'fixture-login-only'
  const taskPassword = 'fixture-task-input-only'
  const command = 'fixture-deploy-with-password'
  /** 跟踪认证、PTY 与输入，仅用于证明真实协议边界。 */
  let passwordAttempts = 0
  let acceptedConnections = 0
  let taskPtyRequested = false
  let receivedTaskInput = ''
  /** 连接关闭时由 finally 统一销毁两端，避免断言失败残留 socket。 */
  const serverConnections: Array<{ end(): void }> = []
  const server = new Server({ hostKeys: [createServerOpsSshFixtureHostKey()] }, (peer) => {
    acceptedConnections += 1; serverConnections.push(peer)
    peer.on('error', () => {})
    peer.on('authentication', (authentication) => {
      if (authentication.method === 'password') passwordAttempts += 1
      if (authentication.method === 'password' && authentication.username === 'fixture-user' && authentication.password === loginPassword) authentication.accept()
      else authentication.reject()
    })
    peer.on('ready', () => peer.on('session', (accept) => {
      /** 同一 transport 上每次 shell/exec 仍拥有独立 SSH session。 */
      const session = accept()
      let hasPty = false
      session.on('pty', (acceptPty) => { hasPty = true; acceptPty() })
      session.on('shell', (acceptShell) => {
        const shell = acceptShell()
        shell.on('error', () => {})
        shell.on('data', (data: Buffer) => shell.write(`manual:${data.toString()}`))
      })
      session.on('exec', (acceptExec, rejectExec, info) => {
        if (info.command !== command || !hasPty) { rejectExec(); return }
        taskPtyRequested = hasPty
        const task = acceptExec()
        task.on('error', () => {})
        task.write('[fixture sudo] password: ')
        task.on('data', (data: Buffer) => {
          receivedTaskInput += data.toString()
          if (!receivedTaskInput.includes('\n')) return
          if (receivedTaskInput.trim() !== taskPassword) { task.exit(99); task.end(); return }
          // 模拟 sudo 的 no-echo 提示：用户输入不能出现在远程输出。
          task.write('\r\ndeployment fixture finished\r\n')
          task.exit(23); task.end()
        })
      })
    }))
  })
  /** 只连接系统分配的 localhost 临时端口。 */
  const client = new Client()
  client.on('error', () => {})
  let service: ServerOpsTaskService | undefined
  let controller: ServerOpsTaskRuntimeController<ReturnType<typeof setTimeout>> | undefined
  let manual: ClientChannel | undefined
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() })
    })
    const port = (server.address() as AddressInfo).port
    await new Promise<void>((resolve, reject) => {
      client.once('ready', resolve); client.once('error', reject)
      client.connect({ host: '127.0.0.1', port, username: 'fixture-user', password: loginPassword, hostVerifier: () => true, readyTimeout: 3_000 })
    })
    manual = await new Promise<ClientChannel>((resolve, reject) => {
      client.shell({ term: 'xterm-256color', cols: 80, rows: 24 }, (error, channel) => error ? reject(error) : resolve(channel))
    })
    expect(await waitForEcho(manual, 'manual:before-task', 'before-task\n')).toContain('manual:before-task')

    /** 连接服务适配器只传递同一个真实 client 的 runtime 事件与 ACK。 */
    const startResolvers = new Map<string, (identity: ServerOpsTaskIdentity) => void>()
    const outputListeners = new Set<Parameters<ServerOpsTaskServiceDependencies['connection']['onTaskOutput']>[0]>()
    const exitListeners = new Set<Parameters<ServerOpsTaskServiceDependencies['connection']['onTaskExit']>[0]>()
    const audit: ServerOpsAuditAppendInput[] = []
    const acknowledged: number[] = []
    const runtime = new ServerOpsTaskRuntimeController<ReturnType<typeof setTimeout>>({
      execute: (remoteCommand, options, callback) => {
        client.exec(remoteCommand, options, (error, channel) => {
          if (error) { callback(error); return }
          callback(undefined, {
            onData: (listener) => { channel.on('data', listener) },
            onStderrData: (listener) => { channel.stderr.on('data', listener) },
            onceExit: (listener) => { channel.once('exit', listener) },
            onceClose: (listener) => { channel.once('close', listener) },
            onceError: (listener) => { channel.once('error', listener) },
            write: (data) => { channel.write(data) },
            setWindow: (rows, cols, height, width) => { channel.setWindow(rows, cols, height, width) },
            close: () => { channel.close() },
          })
        })
      },
      post: (message) => {
        if (message.type === 'server-ops.task-started') startResolvers.get(message.session.taskId)?.(message.session)
        if (message.type === 'server-ops.task-output') for (const listener of outputListeners) listener({ ...message.event, generation: 1 })
        if (message.type === 'server-ops.task-exit') for (const listener of exitListeners) listener({ ...message.event, generation: 1 })
      },
      setTimer: (callback, delay) => setTimeout(callback, delay), clearTimer: (timer) => clearTimeout(timer),
    })
    controller = runtime
    const tasks = new ServerOpsTaskService({
      connection: {
        getActiveIdentity: (hostId) => ({ hostId, connectionId: 'fixture-connection', generation: 1 }),
        startTask: (identity, taskId, remoteCommand, cols, rows) => new Promise((resolve) => {
          startResolvers.set(taskId, resolve)
          runtime.start({ hostId: identity.hostId, connectionId: identity.connectionId, taskId, command: remoteCommand, cols, rows })
        }),
        stopTask: async (identity) => { runtime.stop(identity) },
        writeTask: (input) => runtime.write(input), resizeTask: (input) => runtime.resize(input),
        acknowledgeTask: (input) => { acknowledged.push(input.sequence); runtime.acknowledge(input) },
        onTaskOutput: (listener) => { outputListeners.add(listener); return () => { outputListeners.delete(listener) } },
        onTaskExit: (listener) => { exitListeners.add(listener); return () => { exitListeners.delete(listener) } },
        onState: () => () => {},
      },
      audit: { append: (input) => { audit.push(input); return { ...input, id: `audit-${audit.length}`, timestamp: Date.now() } } },
      getSession: (id) => ({ id, title: '回环测试', createdAt: 1, updatedAt: 1 }), uuid: () => 'fixture-task',
    })
    service = tasks
    const task = await tasks.start('fixture-session', { hostId: 'fixture-host', connectionId: 'fixture-connection', command }, () => {})
    const target = { sessionId: task.sessionId, taskId: task.taskId }
    const prompt = await tasks.read({ ...target, waitMs: 3_000 })
    expect(prompt.output).toContain('[fixture sudo] password:')
    expect(prompt.task.state).toBe('running')
    expect(audit.map((entry) => entry.phase)).toEqual(['start'])
    expect(await waitForEcho(manual, 'manual:during-task', 'during-task\n')).toContain('manual:during-task')

    // 先挂起事件驱动 read，再发送用户输入，证明读等待被远端数据唤醒。
    const waiting = tasks.read({ ...target, offset: prompt.nextOffset, waitMs: 3_000 })
    tasks.write({ ...target, data: `${taskPassword}\n` })
    let result: ServerOpsTaskReadResult = await waiting
    let output = prompt.output + result.output
    /** 最多两次读可覆盖数据与退出事件的不同调度顺序；均由事件唤醒。 */
    for (let attempt = 0; attempt < 2 && (result.task.state === 'running' || result.task.state === 'starting'); attempt++) {
      result = await tasks.read({ ...target, offset: result.nextOffset, waitMs: 3_000 })
      output += result.output
    }
    expect(result.task).toMatchObject({ state: 'exited', exitCode: 23 })
    expect(output).toContain('deployment fixture finished')
    expect(output).not.toContain(taskPassword)
    expect(JSON.stringify(audit)).not.toContain(taskPassword)
    expect(audit[1]).toMatchObject({ phase: 'result', outcome: 'error', exitCode: 23 })
    expect(acknowledged.length).toBeGreaterThanOrEqual(2)
    expect(taskPtyRequested).toBe(true)
    expect(receivedTaskInput).toBe(`${taskPassword}\n`)
    expect(await waitForEcho(manual, 'manual:after-task', 'after-task\n')).toContain('manual:after-task')
    expect(passwordAttempts).toBe(1)
    expect(acceptedConnections).toBe(1)
  } finally {
    service?.dispose(); controller?.dispose(); manual?.close(); client.destroy()
    for (const peer of serverConnections) peer.end()
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}, 15_000)
