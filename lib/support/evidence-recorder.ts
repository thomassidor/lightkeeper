import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, open, stat, truncate, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { KeyedMutex } from './keyed-mutex';
import { redactKeyMaterial } from './homey-errors';
import type { EvidenceSink } from './evidence-sink';

type RecordingState = 'recording' | 'complete' | 'stopped' | 'full' | 'error';
interface Manifest {
  schema: 1;
  id: string;
  key: string;
  startedAt: number;
  endsAt: number;
  state: RecordingState;
  bytes: number;
  records: number;
  dropped: number;
  sequence: number;
  lastFlushAt: number | null;
  error: string | null;
}
export interface EvidenceStatus {
  id: string | null;
  state: RecordingState | 'idle';
  startedAt: number | null;
  endsAt: number | null;
  bytes: number;
  records: number;
  dropped: number;
  pending: number;
  lastFlushAt: number | null;
  error: string | null;
  maxBytes: number;
}
export interface EvidenceDeps {
  directory: string;
  settings: { get(key: string): unknown; set(key: string, value: unknown): void; unset(key: string): void };
  now?: () => number;
  maxBytes?: number;
}

const SETTING = 'evidenceRecordingV1';
const WEEK = 7 * 24 * 60 * 60_000;
const BATCH_BYTES = 48 * 1024;
const BUFFER_BYTES = 512 * 1024;
const PAGE_BYTES = 128 * 1024;
const MAX_RECORD_BYTES = 32 * 1024;

/** Persistent, bounded evidence for an explicit home test. Userdata is served
 * publicly by Homey, so only authenticated API handlers may decrypt these files.
 * The key stays in app settings; neither status nor export includes it.
 * https://apps.developer.homey.app/the-basics/app/persistent-storage
 *
 * Writes are batched, compressed and serialised. No disk IO is awaited by a lamp
 * callback. A crash can lose the unflushed buffer (normally at most 15 seconds).
 * A hard storage limit stops recording instead of silently deleting day one. */
export class EvidenceRecorder {
  private manifest: Manifest | null = null;
  private readonly lock = new KeyedMutex();
  private pending: string[] = [];
  private pendingBytes = 0;
  private initError: string | null = null;
  private readonly bootId = randomUUID();
  private flushing: Promise<void> | null = null;
  readonly maxBytes: number;

  constructor(private readonly deps: EvidenceDeps) {
    this.maxBytes = deps.maxBytes ?? 64 * 1024 * 1024;
  }

  private now(): number { return this.deps.now?.() ?? Date.now(); }
  private path(): string { return join(this.deps.directory, `${this.manifest!.id}.enc`); }
  private save(): void { this.deps.settings.set(SETTING, { ...this.manifest! }); }

  async init(context: unknown): Promise<void> {
    const stored = this.deps.settings.get(SETTING) as Manifest | null | undefined;
    if (!stored) return;
    if (stored.schema !== 1 || !/^[a-f0-9-]{36}$/.test(stored.id)
      || !/^[a-f0-9]{64}$/.test(stored.key) || !Number.isSafeInteger(stored.bytes) || stored.bytes < 0) {
      this.initError = 'The saved recording metadata is invalid; recording was not resumed.';
      return;
    }
    this.manifest = { ...stored };
    try {
      const file = await stat(this.path());
      if (file.size < stored.bytes) throw new Error('The recording file is shorter than its committed length.');
      // A crash between append and metadata commit can leave an incomplete tail.
      // Only committed bytes are exported; never parse or append after that tail.
      if (file.size > stored.bytes) await truncate(this.path(), stored.bytes);
      this.record('app_boot', { context, recoveredTailBytes: file.size - stored.bytes });
      await this.flush();
    } catch (error) { this.fail(error); }
  }

  status(): EvidenceStatus {
    const m = this.manifest;
    return {
      id: m?.id ?? null, state: this.initError ? 'error' : m?.state ?? 'idle',
      startedAt: m?.startedAt ?? null, endsAt: m?.endsAt ?? null,
      bytes: m?.bytes ?? 0, records: m?.records ?? 0, dropped: m?.dropped ?? 0,
      pending: this.pending.length, lastFlushAt: m?.lastFlushAt ?? null,
      error: this.initError ?? m?.error ?? null, maxBytes: this.maxBytes,
    };
  }

  async start(context: unknown): Promise<EvidenceStatus> {
    return this.lock.run('archive', async () => {
      if (this.initError) throw new Error(this.initError);
      if (this.manifest) throw new Error('A recording already exists. Export and clear it before starting another.');
      await mkdir(this.deps.directory, { recursive: true });
      this.manifest = {
        schema: 1, id: randomUUID(), key: randomBytes(32).toString('hex'),
        startedAt: this.now(), endsAt: this.now() + WEEK, state: 'recording',
        bytes: 0, records: 0, dropped: 0, sequence: 0, lastFlushAt: null, error: null,
      };
      const handle = await open(this.path(), 'wx', 0o600);
      await handle.close();
      this.save();
      this.record('recording_started', context);
      await this.flushLocked();
      return this.status();
    }).catch((error: unknown) => {
      // Refusing a second start must not stop the existing recording.
      if (!this.manifest || this.manifest.records === 0) this.fail(error);
      throw error;
    });
  }

  /** Freeze and redact at receipt: action objects acquire outcomes later, and a
   * mutable object retained here would rewrite history before the next flush. */
  readonly record: EvidenceSink = (type, data) => {
    const m = this.manifest;
    if (!m || m.state !== 'recording' || this.now() >= m.endsAt) return;
    try {
      const line = redactKeyMaterial(JSON.stringify({
        schema: 1, runId: m.id, bootId: this.bootId, sequence: ++m.sequence,
        recordedAt: this.now(), type, data,
      }, (key, value: unknown) => /^(apiKey|key|token|secret|authorization|password)$/i.test(key)
        ? undefined : value)) + '\n';
      const bytes = Buffer.byteLength(line);
      if (bytes > MAX_RECORD_BYTES || this.pendingBytes + bytes > BUFFER_BYTES) { m.dropped++; return; }
      this.pending.push(line);
      this.pendingBytes += bytes;
    } catch { m.dropped++; }
  };

  flush(): Promise<void> {
    // A slow filesystem must not accumulate another queued flush every 15s.
    if (this.flushing) return this.flushing;
    this.flushing = this.lock.run('archive', () => this.flushLocked()).finally(() => { this.flushing = null; });
    return this.flushing;
  }

  private async flushLocked(): Promise<void> {
    const m = this.manifest;
    if (!m || m.state === 'error') return;
    try {
      while (this.pending.length) {
        let size = 0;
        let count = 0;
        for (const line of this.pending) {
          const bytes = Buffer.byteLength(line);
          if (count && size + bytes > BATCH_BYTES) break;
          size += bytes; count++;
        }
        const plain = this.pending.slice(0, count).join('');
        const iv = randomBytes(12);
        const cipher = createCipheriv('aes-256-gcm', Buffer.from(m.key, 'hex'), iv);
        const encrypted = Buffer.concat([cipher.update(gzipSync(plain)), cipher.final()]);
        const frame = JSON.stringify({ iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: encrypted.toString('base64') }) + '\n';
        const bytes = Buffer.byteLength(frame);
        if (m.bytes + bytes > this.maxBytes) {
          m.state = 'full'; m.dropped += this.pending.length;
          this.pending = []; this.pendingBytes = 0;
          this.save(); return;
        }
        const file = await open(this.path(), 'a');
        try { await file.writeFile(frame); await file.sync(); } finally { await file.close(); }
        this.pending.splice(0, count); this.pendingBytes -= size;
        m.bytes += bytes; m.records += count; m.lastFlushAt = this.now();
        this.save();
      }
      if (m.state === 'recording' && this.now() >= m.endsAt) { m.state = 'complete'; this.save(); }
      else if (m.state === 'recording') this.save();
    } catch (error) { this.fail(error); }
  }

  private fail(error: unknown): void {
    const message = redactKeyMaterial(error instanceof Error ? error.message : 'Recording storage failed.');
    if (this.manifest) {
      this.manifest.state = 'error'; this.manifest.error = message;
      this.manifest.dropped += this.pending.length;
      this.pending = []; this.pendingBytes = 0;
      try { this.save(); } catch { /* Status still exposes the error in memory. */ }
    } else this.initError = message;
  }

  async stop(): Promise<EvidenceStatus> {
    return this.lock.run('archive', async () => {
      this.record('recording_stopped', {});
      await this.flushLocked();
      if (this.manifest?.state === 'recording') { this.manifest.state = 'stopped'; this.save(); }
      return this.status();
    });
  }

  async close(): Promise<void> {
    this.record('app_shutdown', {});
    await this.flush(); // Keep the active deadline so a restart resumes this run.
  }

  async clear(id: string): Promise<EvidenceStatus> {
    return this.lock.run('archive', async () => {
      if (!this.manifest || id !== this.manifest.id) throw new Error('Recording id does not match.');
      if (this.manifest.state === 'recording') throw new Error('Stop recording before clearing it.');
      await unlink(this.path()).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
      this.deps.settings.unset(SETTING);
      this.manifest = null; this.pending = []; this.pendingBytes = 0;
      return this.status();
    });
  }

  /** Bounded, authenticated export. The caller freezes end from status.bytes,
   * so downloading an active run neither chases new writes nor stops control. */
  async read(id: string, offset: number, end: number): Promise<{ text: string; next: number }> {
    return this.lock.run('archive', async () => {
      const m = this.manifest;
      if (!m || id !== m.id) throw new Error('Recording id does not match.');
      if (![offset, end].every(Number.isSafeInteger) || offset < 0 || end < offset || end > m.bytes) throw new Error('Invalid recording range.');
      if (offset === end) return { text: '', next: end };
      const file = await open(this.path(), 'r');
      let buffer: Buffer;
      try {
        buffer = Buffer.alloc(Math.min(PAGE_BYTES, end - offset));
        const result = await file.read(buffer, 0, buffer.length, offset);
        buffer = buffer.subarray(0, result.bytesRead);
      } finally { await file.close(); }
      const boundary = buffer.lastIndexOf(10);
      if (boundary < 0) throw new Error('Incomplete recording frame.');
      const lines = buffer.subarray(0, boundary).toString('utf8').split('\n');
      const decoded: string[] = [];
      let consumed = 0;
      let outputBytes = 0;
      for (const line of lines) {
        const frame = JSON.parse(line) as { iv: string; tag: string; data: string };
        const decipher = createDecipheriv('aes-256-gcm', Buffer.from(m.key, 'hex'), Buffer.from(frame.iv, 'base64'));
        decipher.setAuthTag(Buffer.from(frame.tag, 'base64'));
        const packed = Buffer.concat([decipher.update(Buffer.from(frame.data, 'base64')), decipher.final()]);
        const plain = gunzipSync(packed, { maxOutputLength: BATCH_BYTES });
        if (decoded.length && outputBytes + plain.length > 256 * 1024) break;
        decoded.push(plain.toString('utf8'));
        consumed += Buffer.byteLength(line) + 1;
        outputBytes += plain.length;
      }
      return { text: decoded.join(''), next: offset + consumed };
    });
  }
}
