import { createStorage } from '../storage/index.js';

const storage = createStorage();
const applied = await storage.migrate();
console.log(`Applied ${applied.length} migration(s):`, applied);
storage.close();
