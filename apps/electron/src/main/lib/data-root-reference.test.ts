import { describe, expect, test } from 'bun:test'
import { createDataRootReferenceCodec } from './data-root-reference'

describe('受管路径的可移植引用', () => {
  test('Given 自定义根连续迁移 When 保存后在任意新根读取 Then 不依赖旧目录名称', () => {
    /** 初次保存时使用任意名称的数据根。 */
    const first = createDataRootReferenceCodec('/disk/first')
    const reference = first.serialize('/disk/first/agent-workspaces/default/s1/attachments/image.png')
    expect(reference).toBe('dutydeck-data:/agent-workspaces/default/s1/attachments/image.png')
    expect(createDataRootReferenceCodec('/disk/second').resolve(reference)).toBe('/disk/second/agent-workspaces/default/s1/attachments/image.png')
    expect(createDataRootReferenceCodec('/other/third').resolve(reference)).toBe('/other/third/agent-workspaces/default/s1/attachments/image.png')
  })

  test('Given 中文空格百分号文件名 When 引用往返 Then 文件名逐字保留且不重复解码', () => {
    /** 使用可能与 URI 转义混淆的真实文件名。 */
    const codec = createDataRootReferenceCodec('/data')
    const path = '/data/attachments/截图 100% #1 %2F.png'
    const reference = codec.serialize(path)
    expect(reference).toBe('dutydeck-data:/attachments/%E6%88%AA%E5%9B%BE%20100%25%20%231%20%252F.png')
    expect(codec.resolve(reference)).toBe(path)
    expect(codec.serialize(reference)).toBe(reference)
  })

  test('Given Windows 根 When 在另一平台数据根读取 Then 只引用相同相对位置', () => {
    /** Windows 编码遵循盘符与路径分段语义。 */
    const windows = createDataRootReferenceCodec('C:\\Users\\User\\Data')
    const reference = windows.serialize('C:\\Users\\User\\Data\\attachments\\中文.png')
    expect(reference).toBe('dutydeck-data:/attachments/%E4%B8%AD%E6%96%87.png')
    expect(createDataRootReferenceCodec('/mnt/data').resolve(reference)).toBe('/mnt/data/attachments/中文.png')
    expect(createDataRootReferenceCodec('D:\\Moved').resolve(reference)).toBe('D:\\Moved\\attachments\\中文.png')
    expect(createDataRootReferenceCodec('//server/share/data').serialize('//server/share/data/attachments/a.png'))
      .toBe('dutydeck-data:/attachments/a.png')
    expect(createDataRootReferenceCodec('//server/share/data').resolve('dutydeck-data:/attachments/a.png'))
      .toBe('\\\\server\\share\\data\\attachments\\a.png')
  })

  test('Given 历史绝对路径 When 编码 Then 仅已知旧根后代可转换', () => {
    /** 显式提供历史根，不从文件名中的 .proma 或 .DutyDeck 猜测归属。 */
    const codec = createDataRootReferenceCodec('/current', ['/old', '/old/nested'])
    expect(codec.serialize('/old/nested/attachments/a')).toBe('dutydeck-data:/attachments/a')
    expect(codec.resolve('/old/attachments/a')).toBe('/current/attachments/a')
    for (const path of ['/old', '/old-copy/a', '/outside/.DutyDeck/a', '/project/.proma/a', '/old/../external/a', 'conversation/a.png']) {
      expect(codec.serialize(path)).toBe(path)
      expect(codec.resolve(path)).toBe(path)
    }
  })

  test('Given 数据根本身 When 编码目录引用 Then 能在新根恢复目录位置', () => {
    expect(createDataRootReferenceCodec('/first').serialize('/first')).toBe('dutydeck-data:/')
    expect(createDataRootReferenceCodec('/next').resolve('dutydeck-data:/')).toBe('/next')
  })

  test('Given 恶意或损坏引用 When 解析 Then 拒绝路径穿越及编码分隔符', () => {
    /** 不允许 URI 规范化悄悄折叠有害片段。 */
    const codec = createDataRootReferenceCodec('/data')
    for (const reference of [
      'dutydeck-data:/../outside', 'dutydeck-data:/%2e%2e/outside', 'dutydeck-data:/a/./b',
      'dutydeck-data://outside', 'dutydeck-data:/a//b', 'dutydeck-data:/a/%2foutside',
      'dutydeck-data:/a/%5coutside', 'dutydeck-data:/a\\outside', 'dutydeck-data:/%00',
      'dutydeck-data:/bad%zz', 'dutydeck-data:/%E0%A4',
    ]) expect(() => codec.resolve(reference)).toThrow('数据根引用')
    expect(() => createDataRootReferenceCodec('C:\\Data').resolve('dutydeck-data:/file%3Astream')).toThrow('数据根引用')
  })
})
