// Child process for the hard-interruption tests. The parent migrates and seeds
// the database; this process runs the pipeline and SIGKILLs ITSELF at the
// requested point (a real kill: no finally blocks, no rollback handlers).
//   mode "before": inside the contradiction transaction, after the relations and
//                  decision rows were written, immediately before the checkpoint
//                  insert -- i.e. before commit.
//   mode "after":  right after the transaction that wrote the checkpoint has
//                  committed.
import fs from 'node:fs';
import { openDb, runPipeline, scriptedDetector } from './contradictionCheckpointFixture.js';

const [dbPath, opportunityId, mode, verdicts] = process.argv.slice(2);
const storage = openDb(dbPath);
// The marker proves the kill point was reached (on Windows a self-kill reports
// exit status 1 and no signal, which is otherwise indistinguishable from a crash).
const kill = () => { fs.writeFileSync(`${dbPath}.killed`, mode); process.kill(process.pid, 'SIGKILL'); };

if (mode === 'before') {
  const run = storage.run.bind(storage);
  storage.run = (sql, params = []) => {
    if (/INSERT INTO research_checkpoints/.test(sql) && params.includes('CONTRADICTION_PERSISTED')) kill();
    return run(sql, params);
  };
} else {
  const transaction = storage.transaction.bind(storage);
  storage.transaction = (fn) => {
    const out = transaction(fn);
    if (storage.get("SELECT 1 AS x FROM research_checkpoints WHERE checkpoint = 'CONTRADICTION_PERSISTED'")) kill();
    return out;
  };
}
await runPipeline(storage, opportunityId, scriptedDetector(verdicts.split(',')));
// Reaching here means the kill point was never hit.
process.exit(3);
