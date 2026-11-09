import type { Check, LearnContext } from './types';

export interface CheckStatus {
  label: string;
  pass: boolean;
  live: boolean;
  holding: number;
}

export class CheckTracker {
  private latched: boolean[];
  private since: Array<number | null>;
  private allSince: number | null = null;
  private allDone = false;
  private lastT = 0;

  constructor(readonly checks: Check[], private together = false) {
    this.latched = checks.map(() => false);
    this.since = checks.map(() => null);
  }

  get done(): boolean {
    return this.together ? this.allDone : this.latched.every(Boolean);
  }

  update(ctx: LearnContext, t: number): CheckStatus[] {
    if (t < this.lastT) {
      this.since = this.checks.map(() => null);
      this.allSince = null;
    }
    this.lastT = t;
    return this.together ? this.updateTogether(ctx, t) : this.updateEach(ctx, t);
  }

  private updateEach(ctx: LearnContext, t: number): CheckStatus[] {
    return this.checks.map((check, i) => {
      if (this.latched[i]) return { label: check.label, pass: true, live: true, holding: 1 };
      const hold = check.holdS ?? 0;
      if (!check.test(ctx)) {
        this.since[i] = null;
        return { label: check.label, pass: false, live: false, holding: 0 };
      }
      const since = this.since[i] ?? t;
      this.since[i] = since;
      if (t - since >= hold) this.latched[i] = true;
      return { label: check.label, pass: this.latched[i], live: true, holding: hold > 0 ? Math.min(1, (t - since) / hold) : 1 };
    });
  }

  private updateTogether(ctx: LearnContext, t: number): CheckStatus[] {
    const live = this.checks.map((check) => check.test(ctx));
    const hold = Math.max(0, ...this.checks.map((c) => c.holdS ?? 0));
    if (!this.allDone && live.every(Boolean)) {
      this.allSince = this.allSince ?? t;
      if (t - this.allSince >= hold) this.allDone = true;
    } else if (!this.allDone) {
      this.allSince = null;
    }
    let holding = 0;
    if (this.allDone) holding = 1;
    else if (this.allSince !== null) holding = hold > 0 ? Math.min(1, (t - this.allSince) / hold) : 1;
    return this.checks.map((check, i) => ({ label: check.label, pass: this.allDone, live: this.allDone || live[i], holding }));
  }
}
