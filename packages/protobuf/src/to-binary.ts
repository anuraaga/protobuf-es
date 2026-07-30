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

import type { MessageShape } from "./types.js";
import { reflect } from "./reflect/reflect.js";
import { WireType } from "./wire/binary-encoding.js";
import { ReverseWriter } from "./wire/reverse-writer.js";
import type { ScalarValue } from "./reflect/scalar.js";
import { type DescField, type DescMessage, ScalarType } from "./descriptors.js";
import type { ReflectList, ReflectMessage } from "./reflect/index.js";

// bootstrap-inject google.protobuf.FeatureSet.FieldPresence.LEGACY_REQUIRED: const $name = $number;
const LEGACY_REQUIRED = 3;

/**
 * Options for serializing to binary data.
 *
 * V1 also had the option `readerFactory` for using a custom implementation to
 * encode to binary.
 */
export interface BinaryWriteOptions {
  /**
   * Include unknown fields in the serialized output? The default behavior
   * is to retain unknown fields and include them in the serialized output.
   *
   * For more details see https://developers.google.com/protocol-buffers/docs/proto3#unknowns
   */
  writeUnknownFields: boolean;
}

// Default options for serializing binary data.
const writeDefaults: Readonly<BinaryWriteOptions> = {
  writeUnknownFields: true,
};

function makeWriteOptions(
  options?: Partial<BinaryWriteOptions>,
): Readonly<BinaryWriteOptions> {
  return options ? { ...writeDefaults, ...options } : writeDefaults;
}

export function toBinary<Desc extends DescMessage>(
  schema: Desc,
  message: MessageShape<Desc>,
  options?: Partial<BinaryWriteOptions>,
): Uint8Array<ArrayBuffer> {
  return writeFields(
    new ReverseWriter(),
    makeWriteOptions(options),
    reflect(schema, message),
  ).finish();
}

/**
 * Write all fields of the message.
 *
 * The writer fills its buffer from back to front, so everything is written
 * in reverse: unknown fields (which come last on the wire) first, then the
 * fields from the highest field number to the lowest, and for each value the
 * payload before its tag. Once a length-delimited payload is written, its
 * size is known, and the length prefix is prepended - the buffer never has
 * to shift already-written bytes to make room for it.
 */
function writeFields(
  writer: ReverseWriter,
  opts: BinaryWriteOptions,
  msg: ReflectMessage,
): ReverseWriter {
  if (opts.writeUnknownFields) {
    const unknown = msg.getUnknown();
    if (unknown !== undefined) {
      for (let i = unknown.length - 1; i >= 0; i--) {
        const { no, wireType, data } = unknown[i];
        writer.raw(data);
        writer.tag(no, wireType);
      }
    }
  }
  const fields = msg.sortedFields;
  for (let i = fields.length - 1; i >= 0; i--) {
    const f = fields[i];
    if (!msg.isSet(f)) {
      if (f.presence == LEGACY_REQUIRED) {
        throw new Error(`cannot encode ${f} to binary: required field not set`);
      }
      continue;
    }
    writeField(writer, opts, msg, f);
  }
  return writer;
}

/**
 * @private
 */
export function writeField(
  writer: ReverseWriter,
  opts: BinaryWriteOptions,
  msg: ReflectMessage,
  field: DescField,
) {
  switch (field.fieldKind) {
    case "scalar":
    case "enum":
      writeScalar(
        writer,
        msg.desc.typeName,
        field.name,
        field.scalar ?? ScalarType.INT32,
        field.number,
        msg.get(field),
      );
      break;
    case "list":
      writeListField(writer, opts, field, msg.get(field));
      break;
    case "message":
      writeMessageField(writer, opts, field, msg.get(field));
      break;
    case "map": {
      const entries = Array.from(msg.get(field));
      for (let i = entries.length - 1; i >= 0; i--) {
        writeMapEntry(writer, opts, field, entries[i][0], entries[i][1]);
      }
      break;
    }
  }
}

function writeScalar(
  writer: ReverseWriter,
  msgName: string,
  fieldName: string,
  scalarType: ScalarType,
  fieldNo: number,
  value: unknown,
) {
  writeScalarValue(
    writer,
    msgName,
    fieldName,
    scalarType,
    value as ScalarValue,
  );
  writer.tag(fieldNo, writeTypeOfScalar(scalarType));
}

function writeMessageField(
  writer: ReverseWriter,
  opts: BinaryWriteOptions,
  field: DescField &
    ({ fieldKind: "message" } | { fieldKind: "list"; listKind: "message" }),
  message: ReflectMessage,
) {
  if (field.delimitedEncoding) {
    writer.tag(field.number, WireType.EndGroup);
    writeFields(writer, opts, message);
    writer.tag(field.number, WireType.StartGroup);
  } else {
    const before = writer.length;
    writeFields(writer, opts, message);
    writer.uint32(writer.length - before);
    writer.tag(field.number, WireType.LengthDelimited);
  }
}

function writeListField(
  writer: ReverseWriter,
  opts: BinaryWriteOptions,
  field: DescField & { fieldKind: "list" },
  list: ReflectList,
) {
  if (field.listKind == "message") {
    for (let i = list.size - 1; i >= 0; i--) {
      writeMessageField(writer, opts, field, list.get(i) as ReflectMessage);
    }
    return;
  }
  const scalarType = field.scalar ?? ScalarType.INT32;
  if (field.packed) {
    if (!list.size) {
      return;
    }
    const before = writer.length;
    for (let i = list.size - 1; i >= 0; i--) {
      writeScalarValue(
        writer,
        field.parent.typeName,
        field.name,
        scalarType,
        list.get(i) as ScalarValue,
      );
    }
    writer.uint32(writer.length - before);
    writer.tag(field.number, WireType.LengthDelimited);
    return;
  }
  for (let i = list.size - 1; i >= 0; i--) {
    writeScalar(
      writer,
      field.parent.typeName,
      field.name,
      scalarType,
      field.number,
      list.get(i),
    );
  }
}

function writeMapEntry(
  writer: ReverseWriter,
  opts: BinaryWriteOptions,
  field: DescField & { fieldKind: "map" },
  key: unknown,
  value: unknown,
) {
  const before = writer.length;

  // write value, expecting value field number = 2
  switch (field.mapKind) {
    case "scalar":
    case "enum":
      writeScalar(
        writer,
        field.parent.typeName,
        field.name,
        field.scalar ?? ScalarType.INT32,
        2,
        value,
      );
      break;
    case "message": {
      const beforeValue = writer.length;
      writeFields(writer, opts, value as ReflectMessage);
      writer.uint32(writer.length - beforeValue);
      writer.tag(2, WireType.LengthDelimited);
      break;
    }
  }

  // write key, expecting key field number = 1
  writeScalar(writer, field.parent.typeName, field.name, field.mapKey, 1, key);

  writer.uint32(writer.length - before);
  writer.tag(field.number, WireType.LengthDelimited);
}

function writeScalarValue(
  writer: ReverseWriter,
  msgName: string,
  fieldName: string,
  type: ScalarType,
  value: ScalarValue,
) {
  try {
    switch (type) {
      case ScalarType.STRING:
        writer.string(value as string);
        break;
      case ScalarType.BOOL:
        writer.bool(value as boolean);
        break;
      case ScalarType.DOUBLE:
        writer.double(value as number);
        break;
      case ScalarType.FLOAT:
        writer.float(value as number);
        break;
      case ScalarType.INT32:
        writer.int32(value as number);
        break;
      case ScalarType.INT64:
        writer.int64(value as number);
        break;
      case ScalarType.UINT64:
        writer.uint64(value as number);
        break;
      case ScalarType.FIXED64:
        writer.fixed64(value as number);
        break;
      case ScalarType.BYTES:
        writer.bytes(value as Uint8Array);
        break;
      case ScalarType.FIXED32:
        writer.fixed32(value as number);
        break;
      case ScalarType.SFIXED32:
        writer.sfixed32(value as number);
        break;
      case ScalarType.SFIXED64:
        writer.sfixed64(value as number);
        break;
      case ScalarType.SINT64:
        writer.sint64(value as number);
        break;
      case ScalarType.UINT32:
        writer.uint32(value as number);
        break;
      case ScalarType.SINT32:
        writer.sint32(value as number);
        break;
    }
  } catch (e) {
    if (e instanceof Error) {
      throw new Error(
        `cannot encode field ${msgName}.${fieldName} to binary: ${e.message}`,
      );
    }
    throw e;
  }
}

function writeTypeOfScalar(type: ScalarType): WireType {
  switch (type) {
    case ScalarType.BYTES:
    case ScalarType.STRING:
      return WireType.LengthDelimited;
    case ScalarType.DOUBLE:
    case ScalarType.FIXED64:
    case ScalarType.SFIXED64:
      return WireType.Bit64;
    case ScalarType.FIXED32:
    case ScalarType.SFIXED32:
    case ScalarType.FLOAT:
      return WireType.Bit32;
    default:
      return WireType.Varint;
  }
}
