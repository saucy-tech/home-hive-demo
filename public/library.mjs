// Shared by the browser and content tools. Only referenced banks are loaded.
export const LIBRARY_KINDS = ["letter", "trace", "naming", "sort", "order", "pattern"];
const MULTIPLE = new Set(["naming", "sort", "order"]);

export function libraryEntries(index) {
  if (!Array.isArray(index.banks)) throw new Error("Library index needs a banks array");
  const seen = new Set();
  for (const entry of index.banks) {
    if (typeof entry.id !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(entry.id) || !LIBRARY_KINDS.includes(entry.kind)) {
      throw new Error(`Invalid library entry: ${JSON.stringify(entry)}`);
    }
    if (seen.has(entry.id)) throw new Error(`Duplicate library id: ${entry.id}`);
    seen.add(entry.id);
  }
  return index.banks;
}

export function createLibraryResolver(readJSON) {
  const cache = new Map();
  function read(path) {
    if (!cache.has(path)) {
      cache.set(path, Promise.resolve().then(() => readJSON(path)).catch(error => {
        cache.delete(path);
        throw error;
      }));
    }
    return cache.get(path);
  }

  async function block(kind, own) {
    if (!own || typeof own !== "object" || Array.isArray(own)) throw new Error(`Invalid ${kind} block`);
    if (!Object.hasOwn(own, "use")) return own;
    if (typeof own.use !== "string" || !own.use.trim()) throw new Error(`Invalid ${kind} use reference`);
    if (!own.use.startsWith("lib:")) {
      if (kind === "pattern") return own; // Existing same-doc naming lookup.
      throw new Error(`${kind} use must start with lib:`);
    }
    const id = own.use.slice(4);
    const entries = libraryEntries(await read("/library/index.json"));
    const entry = entries.find(entry => entry.id === id);
    if (!entry) throw new Error(`Unknown library bank: ${own.use}`);
    if (entry.kind !== kind) throw new Error(`${own.use} is ${entry.kind}, not ${kind}`);
    const bank = await read(`/library/${id}.json`);
    if (!bank || typeof bank !== "object" || Array.isArray(bank) || Object.hasOwn(bank, "use")) {
      throw new Error(`${own.use} must be a standalone bank without use`);
    }
    const { use, ...overrides } = own;
    // Arrays and nested fields replace whole fields; each doc gets its own copy.
    return structuredClone({ ...bank, ...overrides });
  }

  return async function resolveLibraryDoc(doc) {
    if (!doc.games) return doc;
    const games = { ...doc.games };
    await Promise.all(LIBRARY_KINDS.map(async kind => {
      if (games[kind] == null) return;
      if (MULTIPLE.has(kind)) {
        if (!Array.isArray(games[kind])) throw new Error(`${kind} must be an array of blocks`);
        games[kind] = await Promise.all(games[kind].map(own => block(kind, own)));
      } else games[kind] = await block(kind, games[kind]);
    }));
    return { ...doc, games };
  };
}
