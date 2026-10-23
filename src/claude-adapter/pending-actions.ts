import { randomUUID } from 'node:crypto';

export type ActionDecision = 'approve' | 'reject' | 'continue';
export type PendingAction = {
  actionId: string;
  requestId: string;
  sessionId: string;
  type: 'permission' | 'plan';
  title: string;
  description?: string;
  toolName?: string;
  input?: unknown;
  plan?: string;
};

type Waiter = PendingAction & {
  resolve: (decision: ActionDecision) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

export class PendingActions {
  private readonly waiters = new Map<string, Waiter>();

  create(input: Record<string, unknown>, onPending: (action: PendingAction) => void): Promise<ActionDecision> {
    const sessionId = typeof input.session_id === 'string' ? input.session_id : '';
    const toolName = typeof input.tool_name === 'string' ? input.tool_name : undefined;
    if (!sessionId || !toolName) throw new Error('invalid decision hook input');
    const actionId = typeof input.tool_use_id === 'string' ? input.tool_use_id : randomUUID();
    const requestId = randomUUID();
    const action: PendingAction = {
      actionId,
      requestId,
      sessionId,
      type: toolName === 'ExitPlanMode' ? 'plan' : 'permission',
      title: toolName === 'ExitPlanMode' ? 'Approve plan' : `Allow ${toolName}`,
      toolName,
      input: input.tool_input,
    };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(actionId);
        reject(new Error('decision timeout'));
      }, 5 * 60_000);
      timer.unref();
      this.waiters.set(actionId, { ...action, resolve, reject, timer });
      onPending(action);
    });
  }

  respond(sessionId: string, actionId: string, decision: ActionDecision) {
    const waiter = this.waiters.get(actionId);
    if (!waiter || waiter.sessionId !== sessionId) return false;
    this.waiters.delete(actionId);
    clearTimeout(waiter.timer);
    waiter.resolve(decision);
    return true;
  }

  close() {
    for (const waiter of this.waiters.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error('adapter disconnected'));
    }
    this.waiters.clear();
  }
}

export function decisionHookOutput(event: string, decision: ActionDecision) {
  if (event === 'PermissionRequest') {
    return {
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: decision === 'reject'
          ? { behavior: 'deny', message: 'Rejected from Claude Automation' }
          : { behavior: 'allow' },
      },
    };
  }
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: decision === 'reject' ? 'deny' : 'allow',
      permissionDecisionReason: `Decision from Claude Automation: ${decision}`,
    },
  };
}
