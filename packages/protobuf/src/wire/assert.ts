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

/**
 * Maximum value for a 32-bit floating point value (Protobuf FLOAT).
 */
export const FLOAT32_MAX = 3.4028234663852886e38;

/**
 * Minimum value for a 32-bit floating point value (Protobuf FLOAT).
 */
export const FLOAT32_MIN = -3.4028234663852886e38;

/**
 * Maximum value for an unsigned 32-bit integer (Protobuf UINT32, FIXED32).
 */
export const UINT32_MAX = 0xffffffff;

/**
 * Maximum value for a signed 32-bit integer (Protobuf INT32, SFIXED32, SINT32).
 */
export const INT32_MAX = 0x7fffffff;

/**
 * Minimum value for a signed 32-bit integer (Protobuf INT32, SFIXED32, SINT32).
 */
export const INT32_MIN = -0x80000000;

/**
 * Assert a valid signed protobuf 32-bit integer as a number or string.
 */
export function assertInt32(arg: unknown): asserts arg is number {
  if (typeof arg == "string") {
    arg = Number(arg);
  } else if (typeof arg != "number") {
    throw new Error("invalid int32: " + typeof arg);
  }
  if (
    !Number.isInteger(arg) ||
    (arg as number) > INT32_MAX ||
    (arg as number) < INT32_MIN
  )
    throw new Error("invalid int32: " + arg);
}

/**
 * Assert a valid unsigned protobuf 32-bit integer as a number or string.
 */
export function assertUInt32(arg: unknown): asserts arg is number {
  if (typeof arg == "string") {
    arg = Number(arg);
  } else if (typeof arg != "number") {
    throw new Error("invalid uint32: " + typeof arg);
  }
  if (
    !Number.isInteger(arg) ||
    (arg as number) > UINT32_MAX ||
    (arg as number) < 0
  )
    throw new Error("invalid uint32: " + arg);
}

/**
 * Assert a valid protobuf float value as a number or string.
 */
export function assertFloat32(arg: unknown): asserts arg is number {
  if (typeof arg == "string") {
    const o = arg;
    arg = Number(arg);
    if (Number.isNaN(arg as number) && o !== "NaN") {
      throw new Error("invalid float32: " + o);
    }
  } else if (typeof arg != "number") {
    throw new Error("invalid float32: " + typeof arg);
  }
  if (
    Number.isFinite(arg) &&
    ((arg as number) > FLOAT32_MAX || (arg as number) < FLOAT32_MIN)
  )
    throw new Error("invalid float32: " + arg);
}

/**
 * Number of bytes needed to encode `value` as an unsigned 32-bit varint.
 */
export function varint32Size(value: number): number {
  if (value < 0x80) return 1;
  if (value < 0x4000) return 2;
  if (value < 0x200000) return 3;
  if (value < 0x10000000) return 4;
  return 5;
}
