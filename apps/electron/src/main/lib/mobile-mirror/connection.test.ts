import { describe, expect, it } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
/** 在隔离 Bun 进程运行真实 SDK/stdio 握手，mock 不污染其他业务测试。 */
function probe(mode: 'complete' | 'missing' | 'cancel'): { status: number | null; output: string } {
  const folder = fileURLToPath(new URL('.', import.meta.url))
  const source = `
    import { mock } from 'bun:test';
    mock.module(${JSON.stringify(folder + '../mcp-oauth-service')}, () => ({getMcpApiKeyEnvironment: () => undefined, getMcpOAuthHeaders: async () => undefined}));
    mock.module(${JSON.stringify(folder + '../proxy-settings-service')}, () => ({getEffectiveProxyUrl: async () => undefined}));
    const {connectMobileMirror} = await import(${JSON.stringify(folder + 'connection.ts')});
    const {MOBILE_MIRROR_TOOLS} = await import(${JSON.stringify(folder + 'protocol.ts')});
    const names = ${JSON.stringify(mode)} === 'missing' ? [] : MOBILE_MIRROR_TOOLS;
    const server = 'const readline=require("node:readline"); readline.createInterface({input:process.stdin}).on("line",line=>{const r=JSON.parse(line);if(r.id===undefined)return;let result;if(r.method==="initialize")result={protocolVersion:"2024-11-05",capabilities:{tools:{}},serverInfo:{name:"fixture",version:"1"}};else if(r.method==="tools/list")result={tools:'+JSON.stringify(names.map(name=>({name,inputSchema:{type:'object'}})))+'};else result={content:[{type:"text",text:"ok"}]};process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:r.id,result})+"\\\\n")})';
    const controller = new AbortController();
    if (${JSON.stringify(mode)} === 'cancel') controller.abort();
    try {
      const connection = await connectMobileMirror({type:'stdio',enabled:true,command:'node',args:['-e',server],timeout:2},'isolated',controller.signal);
      if (${JSON.stringify(mode)} !== 'complete') throw new Error('expected refusal');
      const result = await connection.callTool({name:'mobile_get_screen_size',arguments:{device:'fixture'}});
      if (!result.content) throw new Error('missing result');
      await connection.close(); console.log('COMPLETE');
    } catch(error) {
      if (${JSON.stringify(mode)} === 'complete') throw error;
      if (!String(error).includes(${JSON.stringify(mode)} === 'missing' ? '缺少' : '已关闭')) throw error;
      console.log('REFUSED');
    }
  `
  const result = spawnSync(process.execPath, ['-e', source], { encoding: 'utf8', timeout: 10000 })
  return { status: result.status, output: result.stdout + result.stderr }
}
describe('手机镜像生产 SDK 连接', () => {
  it('真实 stdio 握手、工具发现和调用后正常关闭', () => {
    const result = probe('complete'); expect(result.output).toContain('COMPLETE'); expect(result.status).toBe(0)
  })
  it('工具缺失和预先取消拒绝连接且进程正常退出', () => {
    for (const mode of ['missing', 'cancel'] as const) {
      const result = probe(mode); expect(result.output).toContain('REFUSED'); expect(result.status).toBe(0)
    }
  })
})
