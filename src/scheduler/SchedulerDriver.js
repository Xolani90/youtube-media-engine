/**
 * SchedulerDriver is an abstract description of "how jobs get triggered".
 * M0 uses GitHubActionsScheduler (a no-op driver from the application's
 * point of view — GitHub Actions triggers the process externally on a
 * cron schedule defined in .github/workflows/*.yml).
 *
 * The important architectural point: application/business code never
 * calls into GitHub Actions APIs directly, and never assumes the process
 * is invoked by GitHub Actions specifically. A future driver (cron,
 * hosted scheduler, queue worker) can replace this without touching
 * business services, because business services only implement "run once"
 * entry points that any driver can invoke.
 */
export class SchedulerDriver {
  get id() {
    throw new Error('not implemented');
  }

  /** Human-readable description of how this driver expects to be invoked. */
  describe() {
    throw new Error('not implemented');
  }
}

export class GitHubActionsScheduler extends SchedulerDriver {
  get id() {
    return 'github-actions';
  }

  describe() {
    return 'Invoked externally by a scheduled GitHub Actions workflow (cron). ' +
      'This driver performs no scheduling itself — it documents the assumption ' +
      'that the process is run-to-completion once per invocation.';
  }
}

export class LocalCronScheduler extends SchedulerDriver {
  get id() {
    return 'local-cron';
  }

  describe() {
    return 'Invoked externally by a local/OS cron job. Same run-to-completion contract as github-actions.';
  }
}

export function createScheduler(driverId) {
  const drivers = {
    'github-actions': () => new GitHubActionsScheduler(),
    'local-cron': () => new LocalCronScheduler()
  };
  const factory = drivers[driverId];
  if (!factory) throw new Error(`Unknown scheduler driver: ${driverId}`);
  return factory();
}

export default SchedulerDriver;
