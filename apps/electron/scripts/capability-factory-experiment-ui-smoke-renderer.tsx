import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { createEmptySceneDefinition, type CapabilityFactoryExperimentView } from '@proma/shared'
import { applyThemeToDOM } from '../src/renderer/atoms/theme'
import { CapabilityFactoryExperimentSummary } from '../src/renderer/components/capability-factory/CapabilityFactoryExperimentSummary'
import '../src/renderer/styles/globals.css'

/** 最小持久实验快照；不调用模型或读取用户数据。 */
function experiment(overrides: Partial<CapabilityFactoryExperimentView> = {}): CapabilityFactoryExperimentView {
  return { id: 'experiment-1', sceneId: 'scene-1', workspaceFingerprint: 'workspace', revision: 1,
    status: 'prepared', running: false, sceneVersion: 1, datasetId: 'dataset', datasetVersion: 1,
    datasetFingerprint: 'data', protocol: { protocolVersion: 'v1', scorerVersion: 1, primaryMetric: 'f1',
      mode: 'tuple-set', outputPath: '', expectedPath: '', tupleFields: [], normalization: { trim: true, caseFold: false, arrayOrder: 'set' }, requireReview: true },
    protocolFingerprint: 'protocol', samples: Array.from({ length: 10 }, (_, index) => ({ caseId: `case-${index}`,
      sourceGroupId: `source-${index}`, inputFingerprint: `input-${index}`, split: 'held-out', labelStatus: 'complete' })),
    targetStepId: 'extract', baselineDefinition: createEmptySceneDefinition('测试'), modelBindings: [{
      slotId: 'main', declaredModel: 'model', modelId: 'actual-model', channelId: 'channel', channelName: '测试渠道', substituted: false }],
    modelFingerprint: 'model', candidates: [], stages: [], heldOutExposure: 'declared-unseen',
    limits: { maxCalls: 120, maxTransportAttempts: 150, durationMs: 300000 }, calls: [], roundsUsed: 0,
    runUnitsReserved: 0, createdAt: 1, startedAt: null, deadlineAt: null, updatedAt: 1, finishedAt: null,
    providerRevision: 'unknown', proposalCost: 'unattributed', ...overrides }
}

/** 隔离预览只使用合成记录，不调用模型或读写用户业务数据。 */
const record = experiment({ status: 'failed', stopReason: '模型设置发生变化', stages: [{ split: 'held-out',
  candidateId: 'A', candidateFingerprint: 'candidate', startedAt: 1, finishedAt: 2,
  pairs: [{ caseId: 'case-1', baselineRunId: 'baseline-1', candidateRunId: 'candidate-1' }] }] })
Object.assign(window, { setSmokeTheme: (mode: 'light' | 'dark') => applyThemeToDOM(mode, 'default') })
applyThemeToDOM('light', 'default')
createRoot(document.getElementById('root')!).render(<main className="p-3"><CapabilityFactoryExperimentSummary experiments={[record]} /></main>)
