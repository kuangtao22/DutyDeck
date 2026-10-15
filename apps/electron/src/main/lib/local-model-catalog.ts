import type { LocalModelCatalogEntry } from '@proma/shared'

/**
 * 首期目录锁定官方 Qwen 仓库 revision 与 LFS 对象摘要；实际下载始终访问官方源并校验摘要。
 * 2026-10-12 元数据经 hf-mirror API/LFS 指针读取（官方 API 当时连接超时）。
 * 这些是候选兼容性清单，不宣称实机能力；每次安装后都必须通过引擎能力探测。
 * 新模型只增加清单与验证证据，不增加专用推理适配器。
 */
export const LOCAL_MODEL_CATALOG: readonly LocalModelCatalogEntry[] = [
  {
    assetId: 'qwen3-4b-q4-k-m-bc640142c66e1fdd12af0bd68f40445458f3869b',
    modelId: 'qwen3-4b', name: 'Qwen3 4B', family: 'qwen', architecture: 'qwen3', quantization: 'Q4_K_M',
    revision: 'bc640142c66e1fdd12af0bd68f40445458f3869b',
    downloadUrl: 'https://huggingface.co/Qwen/Qwen3-4B-GGUF/resolve/bc640142c66e1fdd12af0bd68f40445458f3869b/Qwen3-4B-Q4_K_M.gguf',
    sha256: '7485fe6f11af29433bc51cab58009521f205840f5b4ae3a32fa7f92e8534fdf5',
    sizeBytes: 2497280256, diskBytes: 3000000000, memoryBytes: 8000000000,
    license: 'Apache-2.0', contextWindow: 16384, maxTokens: 4096,
  },
  {
    assetId: 'qwen3-0-6b-q8-0-23749fefcc72300e3a2ad315e1317431b06b590a',
    modelId: 'qwen3-0.6b', name: 'Qwen3 0.6B（轻量测试）', family: 'qwen', architecture: 'qwen3', quantization: 'Q8_0',
    revision: '23749fefcc72300e3a2ad315e1317431b06b590a',
    downloadUrl: 'https://huggingface.co/Qwen/Qwen3-0.6B-GGUF/resolve/23749fefcc72300e3a2ad315e1317431b06b590a/Qwen3-0.6B-Q8_0.gguf',
    sha256: '9465e63a22add5354d9bb4b99e90117043c7124007664907259bd16d043bb031',
    sizeBytes: 639446688, diskBytes: 1000000000, memoryBytes: 3000000000,
    license: 'Apache-2.0', contextWindow: 16384, maxTokens: 2048,
  },
]
