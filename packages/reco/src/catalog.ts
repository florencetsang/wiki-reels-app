import { FIELD_IDS } from "@wiki-reels/shared";
import { normalize } from "./vec.ts";

/**
 * Catalog snapshot written by scripts/build-catalog.ts to R2:
 *   catalog/<version>/meta.json   CatalogMetaFile
 *   catalog/<version>/vecs.i8     N x dim int8, row-aligned with meta.items
 *   catalog/current.json          { "version": "<version>" }
 */
export interface CatalogMetaFile {
  version: string;
  model: string;
  dim: number;
  builtAt: string;
  /** Field ids in index order; item.f indexes into this. */
  fields: string[];
  items: CatalogItemFile[];
}

export interface CatalogItemFile {
  /** Wikipedia pageid. */
  id: number;
  /** Title. */
  t: string;
  /** Field index. */
  f: number;
  /** Subfield name. */
  sf: string | null;
  /** Vital level. */
  l: number;
  /** Short summary for the title card. */
  s: string;
  /** Canonical Wikipedia URL. */
  u: string;
  /** Revision id. */
  r: number | null;
  /** Infographic pages: [section title, R2 key]. */
  p: [string, string][];
  /** Popularity prior, 0..1. */
  pop: number;
  /** Quantization scale: value = int8 / sc. */
  sc: number;
}

export class Catalog {
  readonly version: string;
  readonly dim: number;
  readonly size: number;
  readonly items: CatalogItemFile[];
  readonly fields: string[];
  /** Rows per field index. */
  readonly fieldRows: number[][];
  private readonly vecs: Int8Array;
  private readonly invScale: Float32Array;
  private readonly rows = new Map<number, number>();
  private readonly centroids: Float32Array[];

  constructor(meta: CatalogMetaFile, vecs: Int8Array) {
    if (vecs.length !== meta.items.length * meta.dim) {
      throw new Error(`vecs length ${vecs.length} != ${meta.items.length} x ${meta.dim}`);
    }
    this.version = meta.version;
    this.dim = meta.dim;
    this.items = meta.items;
    this.size = meta.items.length;
    this.fields = meta.fields;
    this.vecs = vecs;
    this.invScale = Float32Array.from(meta.items, (it) => 1 / it.sc);
    this.fieldRows = meta.fields.map(() => []);
    meta.items.forEach((it, row) => {
      this.rows.set(it.id, row);
      this.fieldRows[it.f]?.push(row);
    });
    this.centroids = this.fieldRows.map((rows) => {
      const c = new Float32Array(this.dim);
      for (const r of rows) this.addRow(c, r, 1);
      return normalize(c);
    });
  }

  rowOf(pageid: number): number | undefined {
    return this.rows.get(pageid);
  }

  vector(row: number): Float32Array {
    const out = new Float32Array(this.dim);
    this.addRow(out, row, 1);
    return out;
  }

  /** Normalized mean embedding of a field. */
  fieldCentroid(field: number): Float32Array {
    return this.centroids[field];
  }

  dotRow(row: number, u: ArrayLike<number>): number {
    const base = row * this.dim;
    let s = 0;
    for (let j = 0; j < this.dim; j++) s += u[j] * this.vecs[base + j];
    return s * this.invScale[row];
  }

  dotRows(a: number, b: number): number {
    const ba = a * this.dim;
    const bb = b * this.dim;
    let s = 0;
    for (let j = 0; j < this.dim; j++) s += this.vecs[ba + j] * this.vecs[bb + j];
    return s * this.invScale[a] * this.invScale[b];
  }

  /** Cosine similarity of u with every row (embeddings are normalized). */
  dotAll(u: ArrayLike<number>): Float32Array {
    const out = new Float32Array(this.size);
    const uf = Float32Array.from(u);
    for (let r = 0; r < this.size; r++) {
      const base = r * this.dim;
      let s = 0;
      for (let j = 0; j < this.dim; j++) s += uf[j] * this.vecs[base + j];
      out[r] = s * this.invScale[r];
    }
    return out;
  }

  private addRow(out: Float32Array, row: number, w: number): void {
    const base = row * this.dim;
    const k = w * this.invScale[row];
    for (let j = 0; j < this.dim; j++) out[j] += k * this.vecs[base + j];
  }
}

/** Quantizes normalized vectors to int8 with a per-row scale. */
export function quantize(vectors: ArrayLike<number>[], dim: number): { vecs: Int8Array; scales: number[] } {
  const vecs = new Int8Array(vectors.length * dim);
  const scales = vectors.map((v, r) => {
    let max = 0;
    for (let j = 0; j < dim; j++) max = Math.max(max, Math.abs(v[j]));
    const sc = max > 0 ? 127 / max : 1;
    for (let j = 0; j < dim; j++) vecs[r * dim + j] = Math.round(v[j] * sc);
    return sc;
  });
  return { vecs, scales };
}

export const DEFAULT_FIELDS = [...FIELD_IDS];
