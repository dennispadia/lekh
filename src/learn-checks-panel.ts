import { learnChecks, learnPathIssues, type LearnIssue, type LearnPathStatus } from '../lib/learn-checks.js';

interface LearnContext { id: string; markdown: string; path: string | null }
interface Options {
  context: () => LearnContext | undefined;
  checkPaths: (id: string, paths: string[]) => Promise<LearnPathStatus[]>;
  jump: (line: number) => void;
  allowFolder: (kind: 'image' | 'include') => Promise<void>;
  report: (message: string) => void;
}

const severityLabel: Record<LearnIssue['severity'], string> = { error: 'Error', warning: 'Warning', info: 'Info' };

/** Optional Learn publishing suggestions shown beside every editing view. */
export class LearnChecksPanel {
  private readonly panel = document.querySelector<HTMLElement>('#learn-panel')!;
  private readonly status = document.querySelector<HTMLElement>('#learn-status')!;
  private readonly list = document.querySelector<HTMLElement>('#learn-issues')!;
  private timer?: ReturnType<typeof setTimeout>;
  private sequence = 0;
  private signature = '';
  private issues: LearnIssue[] = [];

  constructor(private readonly options: Options) {
    document.querySelector('#learn-check')!.addEventListener('click', () => this.refresh());
    document.querySelector('#learn-close')!.addEventListener('click', () => this.open(false));
    this.panel.addEventListener('keydown', event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); this.open(false); }
    });
  }

  get isOpen(): boolean { return !this.panel.hidden; }

  open(open = this.panel.hidden): void {
    this.panel.hidden = !open;
    for (const control of document.querySelectorAll('[data-action="learn-checks"]')) {
      control.setAttribute('aria-expanded', String(open));
      if (control.classList.contains('learn-control')) control.setAttribute('aria-pressed', String(open));
    }
    if (open) {
      this.refresh();
      document.querySelector<HTMLButtonElement>('#learn-check')!.focus();
    }
  }

  refresh(): void {
    this.signature = '';
    this.schedule(true);
  }

  schedule(immediate = false): void {
    const context = this.options.context();
    if (!context) return;
    const signature = JSON.stringify([context.id, context.path, context.markdown]);
    if (signature === this.signature) return;
    this.signature = signature;
    clearTimeout(this.timer);
    const sequence = ++this.sequence;
    this.list.replaceChildren();
    for (const badge of document.querySelectorAll<HTMLElement>('.learn-badge')) badge.hidden = true;
    this.status.textContent = 'Checking this document\u2026';
    this.timer = setTimeout(() => { void this.check(context, sequence); }, immediate ? 0 : 450);
  }

  private async check(context: LearnContext, sequence: number): Promise<void> {
    const { issues, references } = learnChecks(context.markdown);
    let pathIssues: LearnIssue[] = [];
    let pathError = '';
    if (references.length) {
      try {
        const statuses = await this.options.checkPaths(context.id, references.map(reference => reference.path));
        if (statuses.length !== references.length) throw new Error('The path check returned an incomplete result. Check again.');
        pathIssues = learnPathIssues(references, statuses);
      }
      catch (error) { pathError = error instanceof Error ? error.message : String(error); }
    }
    if (sequence !== this.sequence) return;
    this.issues = [...issues, ...pathIssues].sort((left, right) => left.line - right.line);
    this.render(pathError);
  }

  private render(pathError: string): void {
    const counted = this.issues.filter(issue => issue.severity !== 'info').length;
    for (const badge of document.querySelectorAll<HTMLElement>('.learn-badge')) {
      badge.textContent = counted > 99 ? '99+' : String(counted);
      badge.hidden = counted === 0;
    }
    for (const control of document.querySelectorAll<HTMLElement>('[data-action="learn-checks"]')) {
      control.title = counted ? `Learn checks: ${counted} ${counted === 1 ? 'suggestion' : 'suggestions'}` : 'Learn checks: no suggestions';
    }
    const errors = this.issues.filter(issue => issue.severity === 'error').length;
    const warnings = this.issues.filter(issue => issue.severity === 'warning').length;
    this.status.textContent = pathError ? `Local paths could not be checked: ${pathError}`
      : this.issues.length ? `${errors} ${errors === 1 ? 'error' : 'errors'}, ${warnings} ${warnings === 1 ? 'warning' : 'warnings'}, ${this.issues.length - errors - warnings} info. Suggestions never block saving.`
      : 'No issues found by these local checks. This is not a full Learn build validation.';
    this.list.replaceChildren(...this.issues.map(issue => {
      const row = document.createElement('li');
      row.className = `learn-issue learn-${issue.severity}`;
      const jump = document.createElement('button');
      jump.type = 'button';
      jump.className = 'learn-jump';
      jump.title = `Go to line ${issue.line}`;
      const severity = document.createElement('span');
      severity.className = 'learn-severity';
      severity.textContent = severityLabel[issue.severity];
      const line = document.createElement('span');
      line.className = 'learn-line';
      line.textContent = `Line ${issue.line}`;
      const message = document.createElement('span');
      message.className = 'learn-message';
      message.textContent = issue.message;
      jump.append(severity, line, message);
      jump.addEventListener('click', () => this.options.jump(issue.line));
      row.append(jump);
      if (issue.reference && /outside the allowed folders/.test(issue.message)) {
        const allow = document.createElement('button');
        allow.type = 'button';
        allow.className = 'learn-fix';
        allow.textContent = 'Allow folder\u2026';
        const kind = issue.reference.kind;
        allow.addEventListener('click', () => {
          void this.options.allowFolder(kind).then(() => this.refresh(), error => this.options.report(error instanceof Error ? error.message : String(error)));
        });
        row.append(allow);
      }
      return row;
    }));
  }
}
