// All native sessions for an alias share this budget, including the temporary
// directory browser. Fresh connections otherwise burst past sshd's MaxStartups.
const MAX_COMMANDS_PER_ALIAS = 2;

interface QueuedCommand {
  start: (release: () => void) => void;
  fail: (error: unknown) => void;
  queued: boolean;
}

interface AliasQueue {
  active: number;
  pending: QueuedCommand[];
  draining: boolean;
}

const aliases = new Map<string, AliasQueue>();

/**
 * Start immediately if possible, otherwise wait FIFO. The returned function
 * removes only a still-queued command. A started command owns its slot until it
 * calls release, including the cancellation/kill grace period. PTYs do not use
 * this queue: keeping an interactive shell open must not starve file access.
 */
export function scheduleSshCommand(
  alias: string,
  start: (release: () => void) => void,
  fail: (error: unknown) => void,
): () => void {
  const key = alias.toLowerCase();
  let queue = aliases.get(key);
  if (!queue) {
    queue = { active: 0, pending: [], draining: false };
    aliases.set(key, queue);
  }
  const state = queue;
  const discardIdle = () => {
    if (state.active === 0 && state.pending.length === 0 && aliases.get(key) === state) aliases.delete(key);
  };
  const drain = () => {
    if (state.draining) return;
    state.draining = true;
    try {
      while (state.active < MAX_COMMANDS_PER_ALIAS && state.pending.length > 0) {
        const next = state.pending.shift()!;
        next.queued = false;
        state.active++;
        let released = false;
        const release = () => {
          if (released) return;
          released = true;
          state.active--;
          drain();
        };
        try { next.start(release); }
        catch (error) { release(); next.fail(error); }
      }
    } finally {
      state.draining = false;
      discardIdle();
    }
  };
  const command: QueuedCommand = { start, fail, queued: true };
  state.pending.push(command);
  drain();
  return () => {
    if (!command.queued) return;
    command.queued = false;
    const index = state.pending.indexOf(command);
    if (index >= 0) state.pending.splice(index, 1);
    discardIdle();
  };
}
