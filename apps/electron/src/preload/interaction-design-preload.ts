import { INTERACTION_DESIGN_CHANNELS, assertPrototypeId } from '@proma/shared'
import type { InteractionDesignApi, InteractionDesignInputs, InteractionDesignMethod, InteractionDesignResults } from '@proma/shared'

/** 构造 renderer 窄桥，不向页面传递 Electron 事件或路径权限。 */
export function createInteractionDesignPreload(
  invoke: (channel: string, value: unknown) => Promise<unknown>,
  subscribe: (channel: string, listener: (value: unknown) => void) => () => void,
): InteractionDesignApi {
  return {
    async invoke<M extends InteractionDesignMethod>(method: M, input: InteractionDesignInputs[M]): Promise<InteractionDesignResults[M]> {
      return await invoke(INTERACTION_DESIGN_CHANNELS.INVOKE, { method, input }) as InteractionDesignResults[M]
    },
    onChanged(callback) {
      return subscribe(INTERACTION_DESIGN_CHANNELS.CHANGED, (value) => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return
        const event = value as { workspaceId?: unknown; prototypeId?: unknown }
        try {
          assertPrototypeId(event.workspaceId)
          if (event.prototypeId !== undefined) assertPrototypeId(event.prototypeId)
          callback({ workspaceId: event.workspaceId, ...(typeof event.prototypeId === 'string' ? { prototypeId: event.prototypeId } : {}) })
        } catch { /* 损坏广播不进入 UI 状态。 */ }
      })
    },
  }
}
