// Node coordinates for very large extracts, without a JavaScript Map. A Map holds at most about
// 16.7 million entries, and each entry costs far more than its 24 bytes of data. Here the ids
// are one sorted Float64Array (OSM ids are below 2^53, so they are exact), with the latitudes and
// longitudes in two more Float64Arrays at the same positions, found by binary search.
// Typed arrays live outside the JavaScript heap, so they do not count against --max-old-space-size.
//
// CoordStore answers the same questions as the Map it replaces (has, get -> [lat, lon], size,
// keys, and iteration as [id, [lat, lon]]), so buildRoadGraph takes either. Our own code.

export const BYTES_PER_NODE = 24; // id, lat and lon as 8-byte floats

// Position of id in the sorted array ids (only the first n entries are used), or -1.
export function indexOfSorted(ids, id, n = ids.length) {
  let lo = 0;
  let hi = n - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const v = ids[mid];
    if (v < id) lo = mid + 1;
    else if (v > id) hi = mid - 1;
    else return mid;
  }
  return -1;
}

// A list of ids that grows as needed. finish() returns them sorted, each once.
export class IdList {
  constructor(capacity = 1024) {
    this.ids = new Float64Array(Math.max(16, capacity));
    this.length = 0;
  }

  push(id) {
    if (this.length === this.ids.length) {
      const bigger = new Float64Array(this.ids.length * 2);
      bigger.set(this.ids);
      this.ids = bigger;
    }
    this.ids[this.length++] = id;
  }

  finish() {
    const ids = this.ids.subarray(0, this.length);
    ids.sort(); // typed arrays sort numerically
    let n = 0;
    for (let i = 0; i < ids.length; i++) if (n === 0 || ids[i] !== ids[n - 1]) ids[n++] = ids[i];
    const out = ids.slice(0, n); // a copy of the right size, so the big buffer can be freed
    this.ids = new Float64Array(16);
    this.length = 0;
    return out;
  }
}

export class CoordStore {
  // ids sorted ascending, each once; lats and lons at the same positions.
  constructor(ids = new Float64Array(0), lats = new Float64Array(0), lons = new Float64Array(0)) {
    this.ids = ids;
    this.lats = lats;
    this.lons = lons;
  }

  get size() {
    return this.ids.length;
  }

  get byteLength() {
    return this.ids.byteLength + this.lats.byteLength + this.lons.byteLength;
  }

  indexOf(id) {
    return indexOfSorted(this.ids, id);
  }

  has(id) {
    return indexOfSorted(this.ids, id) >= 0;
  }

  get(id) {
    const i = indexOfSorted(this.ids, id);
    return i < 0 ? undefined : [this.lats[i], this.lons[i]];
  }

  *keys() {
    for (let i = 0; i < this.ids.length; i++) yield this.ids[i];
  }

  *entries() {
    for (let i = 0; i < this.ids.length; i++) yield [this.ids[i], [this.lats[i], this.lons[i]]];
  }

  [Symbol.iterator]() {
    return this.entries();
  }

  // A new store holding the ids (sorted, each once, all present here) given.
  pick(ids) {
    const lats = new Float64Array(ids.length);
    const lons = new Float64Array(ids.length);
    let j = 0;
    for (let i = 0; i < ids.length; i++) {
      // Both lists are sorted, so the search can start where the last one ended.
      while (j < this.ids.length && this.ids[j] < ids[i]) j++;
      if (this.ids[j] !== ids[i]) throw new Error(`CoordStore.pick: node ${ids[i]} is not in the store`);
      lats[i] = this.lats[j];
      lons[i] = this.lons[j];
    }
    return new CoordStore(Float64Array.from(ids), lats, lons);
  }

  // Map, CoordStore or [[id, [lat, lon]]] -> CoordStore.
  static from(source) {
    if (source instanceof CoordStore) return source;
    const b = new CoordStoreBuilder(source.size ?? 16);
    for (const [id, [lat, lon]] of source) b.add(id, lat, lon);
    return b.finish();
  }

  // One store with every id of the given stores. Where an id is in several, the last one wins
  // (as Map.set would do).
  static merge(stores) {
    let out = new CoordStore();
    for (const s of stores) out = mergeTwo(out, CoordStore.from(s));
    return out;
  }
}

function mergeTwo(a, b) {
  if (a.size === 0) return b;
  if (b.size === 0) return a;
  const ids = new Float64Array(a.size + b.size);
  const lats = new Float64Array(ids.length);
  const lons = new Float64Array(ids.length);
  let i = 0;
  let j = 0;
  let n = 0;
  while (i < a.size || j < b.size) {
    let from;
    let k;
    if (j >= b.size || (i < a.size && a.ids[i] < b.ids[j])) {
      from = a;
      k = i++;
    } else {
      if (i < a.size && a.ids[i] === b.ids[j]) i++; // same node in both: b wins
      from = b;
      k = j++;
    }
    ids[n] = from.ids[k];
    lats[n] = from.lats[k];
    lons[n] = from.lons[k];
    n++;
  }
  return new CoordStore(ids.slice(0, n), lats.slice(0, n), lons.slice(0, n));
}

// Collects coordinates in any order; finish() sorts them by id (the last value of an id wins).
export class CoordStoreBuilder {
  constructor(capacity = 1024) {
    this.cap = Math.max(16, capacity);
    this.ids = new Float64Array(this.cap);
    this.lats = new Float64Array(this.cap);
    this.lons = new Float64Array(this.cap);
    this.length = 0;
    this.sorted = true;
  }

  add(id, lat, lon) {
    if (this.length === this.cap) {
      this.cap *= 2;
      for (const k of ["ids", "lats", "lons"]) {
        const bigger = new Float64Array(this.cap);
        bigger.set(this[k]);
        this[k] = bigger;
      }
    }
    const n = this.length;
    if (n > 0 && id <= this.ids[n - 1]) this.sorted = false;
    this.ids[n] = id;
    this.lats[n] = lat;
    this.lons[n] = lon;
    this.length++;
  }

  finish() {
    const n = this.length;
    let order = null;
    if (!this.sorted) {
      order = new Uint32Array(n);
      for (let i = 0; i < n; i++) order[i] = i;
      const ids = this.ids;
      order.sort((x, y) => ids[x] - ids[y] || x - y); // stable: the last copy of an id stays last
    }
    const at = (i) => (order ? order[i] : i);
    // Count distinct ids, keeping the last copy of each.
    let m = 0;
    for (let i = 0; i < n; i++) if (i === n - 1 || this.ids[at(i)] !== this.ids[at(i + 1)]) m++;
    const ids = new Float64Array(m);
    const lats = new Float64Array(m);
    const lons = new Float64Array(m);
    let k = 0;
    for (let i = 0; i < n; i++) {
      if (i !== n - 1 && this.ids[at(i)] === this.ids[at(i + 1)]) continue;
      const p = at(i);
      ids[k] = this.ids[p];
      lats[k] = this.lats[p];
      lons[k] = this.lons[p];
      k++;
    }
    return new CoordStore(ids, lats, lons);
  }
}
