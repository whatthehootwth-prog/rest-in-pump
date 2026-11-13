import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { describe, expect, it, beforeEach } from 'vitest';

/**
 * Runs the COMPILED Memorial NFT contract (contracts/memorial → .wasm) against a small in-memory
 * implementation of the NEAR host functions it imports (storage, registers, caller, deposit, logs).
 * This tests the exact artifact that gets deployed, not just the Rust source.
 * Build it first: cd contracts/memorial && cargo build --target wasm32-unknown-unknown --release
 */

const WASM = new URL('../../contracts/memorial/target/wasm32-unknown-unknown/release/rip_memorial.wasm', import.meta.url);
const hasWasm = existsSync(WASM);
const U64_MAX = 2n ** 64n - 1n;

// the server tsconfig has no DOM lib, so describe the bits of the WebAssembly API used here
interface WasmMemory { buffer: ArrayBuffer }
interface WasmModule { readonly _brand?: never }
const WA = (globalThis as unknown as { WebAssembly: {
  Module: { new (bytes: Uint8Array): WasmModule; imports(m: WasmModule): { name: string }[] };
  Instance: new (m: WasmModule, imports: object) => { exports: Record<string, unknown> };
} }).WebAssembly;

class MiniNear {
  storage = new Map<string, Uint8Array>();
  logs: string[] = [];
  private readonly module: WasmModule;
  constructor(bytes: Buffer) { this.module = new WA.Module(bytes); }

  /** Calls a method like a NEAR function call. Returns the parsed return value or throws with the panic message. */
  call(method: string, args: unknown, ctx: { predecessor: string; deposit?: bigint; now?: bigint }): unknown {
    const registers = new Map<bigint, Uint8Array>();
    const input = new TextEncoder().encode(JSON.stringify(args ?? {}));
    let ret: Uint8Array | null = null;
    let mem!: WasmMemory;
    const bytes = (ptr: bigint, len: bigint) => new Uint8Array(mem.buffer, Number(ptr), Number(len)).slice();
    const keyOf = (len: bigint, ptr: bigint) => Buffer.from(bytes(ptr, len)).toString('base64');
    const text = (s: string) => new TextEncoder().encode(s);
    const logsBefore = this.logs.length;
    const utf8At = (len: bigint, ptr: bigint) => {
      if (len === U64_MAX) { const m = new Uint8Array(mem.buffer); let e = Number(ptr); while (m[e] !== 0) e++; return new TextDecoder().decode(m.slice(Number(ptr), e)); }
      return new TextDecoder().decode(bytes(ptr, len));
    };
    const env: Record<string, (...a: bigint[]) => bigint | void> = {
      read_register: (id, ptr) => { const r = registers.get(id); if (r) new Uint8Array(mem.buffer).set(r, Number(ptr)); },
      register_len: (id) => (registers.has(id) ? BigInt(registers.get(id)!.length) : U64_MAX),
      input: (id) => { registers.set(id, input); },
      current_account_id: (id) => { registers.set(id, text('memorial.whatthehoot.near')); },
      predecessor_account_id: (id) => { registers.set(id, text(ctx.predecessor)); },
      attached_deposit: (ptr) => {
        const v = ctx.deposit ?? 0n, b = new Uint8Array(16);
        for (let i = 0; i < 16; i++) b[i] = Number((v >> BigInt(8 * i)) & 0xffn);
        new Uint8Array(mem.buffer).set(b, Number(ptr));
      },
      prepaid_gas: () => 300_000_000_000_000n,
      block_timestamp: () => ctx.now ?? 1_762_600_000_000_000_000n,
      storage_usage: () => BigInt([...this.storage.entries()].reduce((n, [k, v]) => n + k.length + v.length + 40, 0)),
      storage_write: (kl, kp, vl, vp, id) => {
        const k = keyOf(kl, kp), old = this.storage.get(k);
        this.storage.set(k, bytes(vp, vl));
        if (old) { registers.set(id, old); return 1n; }
        return 0n;
      },
      storage_read: (kl, kp, id) => { const v = this.storage.get(keyOf(kl, kp)); if (!v) return 0n; registers.set(id, v); return 1n; },
      storage_remove: (kl, kp, id) => { const k = keyOf(kl, kp), v = this.storage.get(k); if (!v) return 0n; this.storage.delete(k); registers.set(id, v); return 1n; },
      storage_has_key: (kl, kp) => (this.storage.has(keyOf(kl, kp)) ? 1n : 0n),
      sha256: (len, ptr, id) => { registers.set(id, new Uint8Array(createHash('sha256').update(bytes(ptr, len)).digest())); },
      value_return: (len, ptr) => { ret = bytes(ptr, len); },
      log_utf8: (len, ptr) => { this.logs.push(utf8At(len, ptr)); },
      panic_utf8: (len, ptr) => { throw new Error(`panic: ${utf8At(len, ptr)}`); },
      panic: () => { throw new Error('panic'); },
      abort: () => { throw new Error('abort'); },
    };
    const imports: Record<string, (...a: bigint[]) => bigint | void> = {};
    for (const imp of WA.Module.imports(this.module)) {
      imports[imp.name] = env[imp.name] ?? (() => { throw new Error(`host function not available in the test VM: ${imp.name}`); });
    }
    const snapshot = new Map(this.storage);
    const inst = new WA.Instance(this.module, { env: imports });
    mem = inst.exports.memory as WasmMemory;
    try {
      (inst.exports[method] as () => void)();
    } catch (err) {
      this.storage = snapshot;   // a failed call changes nothing
      const msg = this.logs.slice(logsBefore).join(' | ');
      throw new Error(`${method} failed: ${(err as Error).message} ${msg}`);
    }
    return ret ? JSON.parse(new TextDecoder().decode(ret)) : undefined;
  }
}

const OWNER = 'whatthehoot.near', MINTER = 'minter.whatthehoot.near';
type Token = { token_id: string; owner_id: string; metadata: Record<string, string | null> };

describe.skipIf(!hasWasm)('Memorial NFT contract (compiled wasm)', () => {
  let vm: MiniNear;
  const mint = (grave: number, to: string, prefix = '$RUG') =>
    vm.call('mint_memorial', { grave_id: grave, receiver_id: to, name_prefix: prefix, description: 'A memorial' }, { predecessor: MINTER }) as Token;

  beforeEach(() => {
    vm = new MiniNear(readFileSync(WASM));
    vm.call('new', { owner_id: OWNER, minter_id: MINTER, base_uri: 'https://restinpump.example/nft' }, { predecessor: OWNER });
  });

  it('mints numbered memorials per grave with evolving media and metadata paths', () => {
    const a = mint(7, 'alice.near'), b = mint(7, 'bob.near'), c = mint(9, 'alice.near', '$DOG');
    expect([a.token_id, b.token_id, c.token_id]).toEqual(['7-1', '7-2', '9-1']);
    expect(a.owner_id).toBe('alice.near');
    expect(a.metadata.title).toBe('$RUG Memorial #001');
    expect(b.metadata.title).toBe('$RUG Memorial #002');
    expect(a.metadata.media).toBe('grave/7/media.svg');
    expect(a.metadata.reference).toBe('token/7-1.json');
    expect(vm.call('memorial_of', { grave_id: 7, account_id: 'bob.near' }, { predecessor: 'x.near' })).toBe('7-2');
    expect(vm.call('memorial_of', { grave_id: 9, account_id: 'bob.near' }, { predecessor: 'x.near' })).toBeNull();
    expect(vm.call('memorial_count', { grave_id: 7 }, { predecessor: 'x.near' })).toBe(2);
    expect(vm.call('nft_total_supply', {}, { predecessor: 'x.near' })).toBe('3');
    expect(vm.logs.some((l) => l.startsWith('EVENT_JSON:') && l.includes('"nft_mint"'))).toBe(true);
    expect((vm.call('nft_metadata', {}, { predecessor: 'x.near' }) as { base_uri: string; symbol: string })).toMatchObject({ base_uri: 'https://restinpump.example/nft', symbol: 'RIPM' });
  });

  it('allows only one memorial per wallet per grave, and only the minter can mint', () => {
    mint(7, 'alice.near');
    expect(() => mint(7, 'alice.near')).toThrow(/already has a memorial/);
    expect(() => vm.call('mint_memorial', { grave_id: 1, receiver_id: 'eve.near', name_prefix: 'X', description: 'd' }, { predecessor: 'eve.near' }))
      .toThrow(/Only the minter/);
    expect(vm.call('nft_total_supply', {}, { predecessor: 'x.near' })).toBe('1');
  });

  it('is a normal transferable NFT; the original minting record stays', () => {
    mint(7, 'alice.near');
    expect(() => vm.call('nft_transfer', { receiver_id: 'bob.near', token_id: '7-1' }, { predecessor: 'alice.near' })).toThrow();   // needs 1 yocto
    vm.call('nft_transfer', { receiver_id: 'bob.near', token_id: '7-1' }, { predecessor: 'alice.near', deposit: 1n });
    expect((vm.call('nft_token', { token_id: '7-1' }, { predecessor: 'x.near' }) as Token).owner_id).toBe('bob.near');
    expect((vm.call('nft_tokens_for_owner', { account_id: 'bob.near' }, { predecessor: 'x.near' }) as Token[]).map((t) => t.token_id)).toEqual(['7-1']);
    expect(() => mint(7, 'alice.near')).toThrow(/already has a memorial/);
  });

  it('owner-only settings', () => {
    expect(() => vm.call('set_minter', { minter_id: 'eve.near' }, { predecessor: 'eve.near' })).toThrow(/Owner only/);
    vm.call('set_base_uri', { base_uri: 'https://new.example/nft' }, { predecessor: OWNER });
    vm.call('set_minter', { minter_id: 'minter2.whatthehoot.near' }, { predecessor: OWNER });
    expect(vm.call('get_minter', {}, { predecessor: 'x.near' })).toBe('minter2.whatthehoot.near');
    expect(() => mint(1, 'alice.near')).toThrow(/Only the minter/);
  });
});

if (!hasWasm) console.warn('[contract.test] compiled contract not found — build contracts/memorial to run these tests');
