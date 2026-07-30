// Copyright 2021-2026 Buf Technologies, Inc.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import { protoInt64 } from "../proto-int64.js";
import { getTextEncoding } from "./text-encoding.js";
import type { WireType } from "./binary-encoding.js";
import { assertFloat32, assertInt32, assertUInt32 } from "./assert.js";

/**
 * A writer for the protobuf binary format that fills its buffer from back to
 * front, for one-pass serialization of length-delimited data.
 *
 * The binary format requires the length of a length-delimited payload (a
 * submessage, packed list, or map entry) before the payload itself. Writing
 * towards the front means the payload is written first, so its length is
 * known - from how far the write position moved - by the time the prefix
 * must be written, and the prefix is simply prepended. There is no sizing
 * pass, and no shifting of already-written bytes.
 *
 * In exchange, callers must write everything in reverse: the last field
 * first, list items back to front, and for each value the payload before
 * its tag. Every write method prepends, so within a single method arguments
 * keep their natural meaning (e.g. `bytes()` writes the length prefix
 * followed by the data).
 *
 * @private
 */
export class ReverseWriter {
  /**
   * Growable byte buffer, filled from the back. Written data spans
   * [pos, buffer.length).
   */
  private buffer: Uint8Array<ArrayBuffer>;

  /**
   * Cached DataView for fixed-width writes. Read it via `view()`, which
   * rebuilds it if `buffer` has since grown.
   */
  private viewCache: DataView;

  /**
   * Index of the first written byte. Shrinks towards zero as data is
   * written.
   */
  private pos: number;

  constructor(
    private readonly encodeUtf8: (
      text: string,
    ) => Uint8Array = getTextEncoding().encodeUtf8,
  ) {
    // Defer the first Uint8Array allocation: small messages (e.g. a bool-only
    // request) would otherwise pay for a full INITIAL_SIZE zeroed buffer.
    this.buffer = EMPTY_BUFFER;
    this.viewCache = EMPTY_VIEW;
    this.pos = 0;
  }

  /**
   * Number of bytes written so far. Snapshot it before and after writing a
   * length-delimited payload to compute the length prefix.
   */
  get length(): number {
    return this.buffer.length - this.pos;
  }

  private ensureCapacity(size: number) {
    if (this.pos < size) {
      this.grow(size);
    }
  }

  /**
   * Replaces the buffer with a larger one, with the existing data anchored
   * to the end so writing can continue towards the front.
   */
  private grow(size: number) {
    const dataLen = this.length;
    const required = dataLen + size;
    let newLen = this.buffer.length || INITIAL_SIZE;
    while (newLen < required) newLen *= 2;
    const newBuf = new Uint8Array(newLen);
    const newPos = newLen - dataLen;
    if (dataLen > 0) newBuf.set(this.buffer.subarray(this.pos), newPos);
    this.buffer = newBuf;
    this.pos = newPos;
  }

  /**
   * The DataView over `buffer`, rebuilt only if the buffer has grown since it
   * was last used.
   */
  private view(): DataView {
    const bytes = this.buffer;
    const view = this.viewCache;
    // Since grow() only ever replaces the buffer with a strictly larger one,
    // equal lengths mean the view is still current. This is faster than comparing
    // buffers directly.
    if (view.byteLength === bytes.byteLength) return view;

    const newView = new DataView(bytes.buffer);
    this.viewCache = newView;
    return newView;
  }

  /**
   * Return all bytes written and reset this writer.
   */
  finish(): Uint8Array<ArrayBuffer> {
    const result = this.buffer.slice(this.pos);
    this.pos = this.buffer.length;
    return result;
  }

  /**
   * Writes a tag (field number and wire type).
   *
   * Because this writer fills back to front, write the tag after the value
   * it belongs to.
   */
  tag(fieldNo: number, type: WireType): this {
    return this.uint32(((fieldNo << 3) | type) >>> 0);
  }

  /**
   * Write a chunk of raw bytes.
   */
  raw(chunk: Uint8Array): this {
    this.ensureCapacity(chunk.length);
    this.pos -= chunk.length;
    this.buffer.set(chunk, this.pos);
    return this;
  }

  /**
   * Write a `uint32` value, an unsigned 32 bit varint.
   */
  uint32(value: number): this {
    assertUInt32(value);
    // Single-byte varints are by far the most common - they cover field tags
    // for numbers 1-15 plus many small lengths and integers.
    if (value < 0x80) {
      this.ensureCapacity(1);
      this.buffer[--this.pos] = value;
      return this;
    }
    // Encode into scratch space in wire order (least-significant group
    // first), then prepend as one contiguous block.
    let n = 0;
    while (value > 0x7f) {
      varintScratch[n++] = (value & 0x7f) | 0x80;
      value >>>= 7;
    }
    varintScratch[n++] = value;
    return this.prependScratch(n);
  }

  /**
   * Prepends the first `n` bytes of `varintScratch`.
   */
  private prependScratch(n: number): this {
    this.ensureCapacity(n);
    const buf = this.buffer;
    this.pos -= n;
    const p = this.pos;
    for (let i = 0; i < n; i++) {
      buf[p + i] = varintScratch[i];
    }
    return this;
  }

  /**
   * Write a `int32` value, a signed 32 bit varint.
   */
  int32(value: number): this {
    assertInt32(value);
    if (value >= 0) {
      return this.uint32(value);
    }
    // Negative: sign-extend to 64 bits, encodes to 10 bytes.
    this.ensureCapacity(10);
    const buf = this.buffer;
    this.pos -= 10;
    let p = this.pos;
    for (let i = 0; i < 9; i++) {
      buf[p++] = (value & 0x7f) | 0x80;
      value >>= 7;
    }
    buf[p] = 1;
    return this;
  }

  /**
   * Write a `bool` value, a varint.
   */
  bool(value: boolean): this {
    this.ensureCapacity(1);
    this.buffer[--this.pos] = value ? 1 : 0;
    return this;
  }

  /**
   * Write a `bytes` value, length-delimited arbitrary data.
   */
  bytes(value: Uint8Array): this {
    this.raw(value);
    return this.uint32(value.byteLength);
  }

  /**
   * Write a `string` value, length-delimited data converted to UTF-8 text.
   */
  string(value: string): this {
    const chunk = this.encodeUtf8(value);
    this.raw(chunk);
    return this.uint32(chunk.byteLength);
  }

  /**
   * Write a `float` value, 32-bit floating point number.
   */
  float(value: number): this {
    assertFloat32(value);
    this.ensureCapacity(4);
    this.pos -= 4;
    this.view().setFloat32(this.pos, value, true);
    return this;
  }

  /**
   * Write a `double` value, a 64-bit floating point number.
   */
  double(value: number): this {
    this.ensureCapacity(8);
    this.pos -= 8;
    this.view().setFloat64(this.pos, value, true);
    return this;
  }

  /**
   * Write a `fixed32` value, an unsigned, fixed-length 32-bit integer.
   */
  fixed32(value: number): this {
    assertUInt32(value);
    this.ensureCapacity(4);
    this.pos -= 4;
    this.view().setUint32(this.pos, value, true);
    return this;
  }

  /**
   * Write a `sfixed32` value, a signed, fixed-length 32-bit integer.
   */
  sfixed32(value: number): this {
    assertInt32(value);
    this.ensureCapacity(4);
    this.pos -= 4;
    this.view().setInt32(this.pos, value, true);
    return this;
  }

  /**
   * Write a `sint32` value, a signed, zigzag-encoded 32-bit varint.
   */
  sint32(value: number): this {
    assertInt32(value);
    // zigzag encode then emit as uint32 varint
    return this.uint32(((value << 1) ^ (value >> 31)) >>> 0);
  }

  /**
   * Write a `sfixed64` value, a signed, fixed-length 64-bit integer.
   */
  sfixed64(value: string | number | bigint): this {
    const tc = protoInt64.enc(value);
    this.ensureCapacity(8);
    const view = this.view();
    this.pos -= 8;
    const pos = this.pos;
    view.setInt32(pos, tc.lo, true);
    view.setInt32(pos + 4, tc.hi, true);
    return this;
  }

  /**
   * Write a `fixed64` value, an unsigned, fixed-length 64 bit integer.
   */
  fixed64(value: string | number | bigint): this {
    const tc = protoInt64.uEnc(value);
    this.ensureCapacity(8);
    const view = this.view();
    this.pos -= 8;
    const pos = this.pos;
    view.setInt32(pos, tc.lo, true);
    view.setInt32(pos + 4, tc.hi, true);
    return this;
  }

  /**
   * Write a `int64` value, a signed 64-bit varint.
   */
  int64(value: string | number | bigint): this {
    const tc = protoInt64.enc(value);
    return this.writeVarint64(tc.lo, tc.hi);
  }

  /**
   * Write a `sint64` value, a signed, zig-zag-encoded 64-bit varint.
   */
  sint64(value: string | number | bigint): this {
    const tc = protoInt64.enc(value),
      // zigzag encode
      sign = tc.hi >> 31,
      lo = (tc.lo << 1) ^ sign,
      hi = ((tc.hi << 1) | (tc.lo >>> 31)) ^ sign;
    return this.writeVarint64(lo, hi);
  }

  /**
   * Write a `uint64` value, an unsigned 64-bit varint.
   */
  uint64(value: string | number | bigint): this {
    const tc = protoInt64.uEnc(value);
    return this.writeVarint64(tc.lo, tc.hi);
  }

  /**
   * Write a 64-bit varint. Accepts the value as split low/high 32-bit words.
   *
   * The bytes are encoded into scratch space in wire order with the same
   * stepping as BinaryWriter.writeVarint64(), then prepended as one
   * contiguous block.
   */
  private writeVarint64(lo: number, hi: number): this {
    // Single-byte fast path, mirroring uint32().
    if (hi === 0 && lo >>> 7 === 0) {
      this.ensureCapacity(1);
      this.buffer[--this.pos] = lo;
      return this;
    }
    let n = 0;

    for (let i = 0; i < 28; i = i + 7) {
      const shift = lo >>> i;
      const hasNext = !(shift >>> 7 == 0 && hi == 0);
      varintScratch[n++] = (hasNext ? shift | 0x80 : shift) & 0xff;
      if (!hasNext) {
        return this.prependScratch(n);
      }
    }

    const splitBits = ((lo >>> 28) & 0x0f) | ((hi & 0x07) << 4);
    const hasMoreBits = !(hi >> 3 == 0);
    varintScratch[n++] = (hasMoreBits ? splitBits | 0x80 : splitBits) & 0xff;

    if (!hasMoreBits) {
      return this.prependScratch(n);
    }

    for (let i = 3; i < 31; i = i + 7) {
      const shift = hi >>> i;
      const hasNext = !(shift >>> 7 == 0);
      varintScratch[n++] = (hasNext ? shift | 0x80 : shift) & 0xff;
      if (!hasNext) {
        return this.prependScratch(n);
      }
    }

    varintScratch[n++] = (hi >>> 31) & 0x01;
    return this.prependScratch(n);
  }
}

/**
 * Scratch space for encoding multi-byte varints before prepending them.
 * Sharing one buffer across all writers is safe: it is filled and copied out
 * within a single write call, and nothing re-enters in between.
 */
const varintScratch = new Uint8Array(10);

/**
 * Capacity of the buffer allocated by the first write.
 */
const INITIAL_SIZE = 128;

/**
 * Shared empty buffer used as the initial value before the first write.
 * Avoids allocating and zeroing `INITIAL_SIZE` bytes per ReverseWriter when
 * a writer is only used for a tiny message (or not used at all).
 */
const EMPTY_BUFFER = new Uint8Array(0) as Uint8Array<ArrayBuffer>;

/**
 * Shared empty view, paired with `EMPTY_BUFFER`. Never written to: any
 * fixed-width write first grows the buffer, which replaces this view.
 */
const EMPTY_VIEW = new DataView(EMPTY_BUFFER.buffer);
