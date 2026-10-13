/**
 * electron-builder mac.sign 钩子：保留原有签名选项与重试，只在最后封签 app 前更新引擎摘要。
 * osx-sign 按深度先签子文件，最后调用 app 的 optionsForFile；此时 DLL/dylib/Mach-O 字节已稳定。
 */
const { createRequire } = require('node:module')
const { execFileSync } = require('node:child_process')
const { existsSync } = require('node:fs')
const { join, resolve } = require('node:path')

/** 通过项目已有 electron-builder 解析其同版本签名实现，不增加依赖。 */
const builderRequire = createRequire(require.resolve('electron-builder'))
/** 使用 builder 原本的 macCodeSign.sign，保留它的签名失败重试。 */
const { sign: originalSign } = builderRequire('app-builder-lib/out/codeSign/macCodeSign.js')

/** 返回保留原配置的签名选项；仅在外层 app 即将封签时同步刷新清单。 */
function wrapSignOptions(options, refreshManifest) {
  /** 原签名配置包括应用与子文件的 entitlements，必须完整保留。 */
  const originalOptionsForFile = options.optionsForFile
  return {
    ...options,
    optionsForFile(filePath) {
      if (resolve(filePath) === resolve(options.app)) refreshManifest()
      return originalOptionsForFile ? originalOptionsForFile(filePath) : {}
    },
  }
}
exports.wrapSignOptions = wrapSignOptions

/** 接收 builder 的完整签名选项；返回签名 Promise，失败直接阻断打包。 */
exports.sign = async function sign(options, packager) {
  // 自定义 sign 会改变 builder 的无证书分支，显式保留原先允许本地无签名构建的语义。
  if (!options.identity) {
    if (packager.forceCodeSigning) throw new Error('本地引擎签名缺少强制要求的 macOS 证书')
    console.warn('[本地引擎] 未配置 macOS 签名证书，保持原始校验清单，当前包未签名')
    return
  }
  /** 指定绝对脚本路径，避免构建启动目录影响刷新入口。 */
  const prepareScript = resolve(__dirname, 'prepare-local-model-engine.ts')
  await originalSign(wrapSignOptions(options, () => {
    const engineRoot = join(options.app, 'Contents/Resources/local-model-engine')
    // 按需安装模式的安装包只携带版本清单，没有待签名的引擎 manifest。
    if (existsSync(join(engineRoot, 'manifest.json'))) execFileSync('bun', [prepareScript, '--refresh-manifest', engineRoot], { stdio: 'inherit' })
  }))
}
