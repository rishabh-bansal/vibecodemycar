import type { ElmLink } from '../elm/link.ts';
import type { ElmReply } from '../elm/session.ts';
import { PolicyError } from '../safety/policy.ts';
import type { ParsedScript, ScriptStep, Section, SessionSpec } from './script.ts';

export type StepOutcome = 'done' | 'skipped-section' | 'refused' | 'unknown-step' | 'timeout' | 'adapter-rejected';

export interface StepResult {
  index: number;
  step: ScriptStep;
  outcome: StepOutcome;
  /** Why it was refused or skipped. */
  reason?: string;
  reply?: ElmReply;
}

export interface ScriptRun {
  steps: StepResult[];
  /** Replies of the "_" marked steps, in order: the ones to decode. */
  marked: ElmReply[];
  /** Replies of every hex step. */
  replies: ElmReply[];
  refused: StepResult[];
}

export interface RunOptions {
  atTimeoutMs?: number;
  requestTimeoutMs?: number;
  /** Tester-present while the script runs (and while it sleeps). */
  keepAlive?: SessionSpec;
  /** Stop at the first refused step instead of carrying on. */
  stopOnRefused?: boolean;
  /** Hard cap on steps run, whatever the script says. */
  maxSteps?: number;
}

const FAMILY: Record<Section, 'can11' | 'can29'> = { CAN11: 'can11', CAN29: 'can29' };
const SECTION_PROTOCOL: Record<Section, string> = { CAN11: '6', CAN29: '7' };

/**
 * Runs a parsed script on an ELM link. Every command goes through the link's policy: a step the policy
 * refuses is recorded and skipped, the rest still runs. A section for another protocol family is skipped.
 */
export async function runScript(link: ElmLink, script: ParsedScript, opts: RunOptions = {}): Promise<ScriptRun> {
  const clock = link.clock;
  const atTimeout = opts.atTimeoutMs ?? 1500;
  const reqTimeout = opts.requestTimeoutMs ?? 2500;
  const maxSteps = opts.maxSteps ?? 2000;
  const run: ScriptRun = { steps: [], marked: [], replies: [], refused: [] };
  let lastKeepAlive = clock.now();
  let selectedFor: Section | null = null;

  const keepAlive = async () => {
    const ka = opts.keepAlive;
    if (!ka || clock.now() - lastKeepAlive < ka.intervalMs) return;
    lastKeepAlive = clock.now();
    try {
      link.policy.check(ka.testerPresent, { family: link.protocol.family });
      await link.session.send(ka.testerPresent, reqTimeout);
    } catch (e) {
      if (!(e instanceof PolicyError)) throw e;
    }
  };

  let index = -1;
  for (const step of script.steps) {
    index++;
    if (index >= maxSteps) break;
    const rec: StepResult = { index, step, outcome: 'done' };
    run.steps.push(rec);
    if (step.section) {
      const want = FAMILY[step.section];
      if (link.protocol.family !== want && link.protocol.number !== 0) {
        rec.outcome = 'skipped-section';
        rec.reason = `section ${step.section} does not apply to this car (${link.protocol.family})`;
        continue;
      }
      // on a car whose protocol is not found yet, the tag selects it
      if (link.protocol.number === 0 && selectedFor !== step.section) {
        selectedFor = step.section;
        await link.at(`ATSP${SECTION_PROTOCOL[step.section]}`, atTimeout);
      }
    }
    await keepAlive();
    switch (step.kind) {
      case 'unknown':
        rec.outcome = 'unknown-step';
        rec.reason = `not a command: ${step.raw}`;
        break;
      case 'wait': {
        // sleep in slices so tester-present keeps going
        let left = step.ms;
        const slice = opts.keepAlive ? Math.min(opts.keepAlive.intervalMs, 1000) : step.ms;
        while (left > 0) {
          const s = Math.min(left, Math.max(1, slice));
          await clock.sleep(s);
          left -= s;
          await keepAlive();
        }
        break;
      }
      case 'at': {
        try {
          const { ok, reply } = await link.at(step.cmd, atTimeout);
          rec.reply = reply;
          if (reply.status === 'timeout') rec.outcome = 'timeout';
          else if (!ok) rec.outcome = 'adapter-rejected';
        } catch (e) {
          if (!(e instanceof PolicyError)) throw e;
          rec.outcome = 'refused';
          rec.reason = e.message;
        }
        break;
      }
      case 'send': {
        try {
          link.policy.check(step.cmd, { family: link.protocol.family });
        } catch (e) {
          if (!(e instanceof PolicyError)) throw e;
          rec.outcome = 'refused';
          rec.reason = e.message;
          break;
        }
        const reply = await link.session.send(step.cmd, reqTimeout);
        rec.reply = reply;
        if (reply.status === 'timeout') rec.outcome = 'timeout';
        run.replies.push(reply);
        if (step.marked) run.marked.push(reply);
        break;
      }
    }
    if (rec.outcome === 'refused') {
      run.refused.push(rec);
      if (opts.stopOnRefused) break;
    }
  }
  return run;
}
