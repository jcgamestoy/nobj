/*Copyright (c) 2026 Juan Carlos González Amestoy

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.*/

export type SymbolValue = Uint8Array | string | number;

export interface ObjSymbol {
  name: string;
  obj:  SymbolValue;
}

export type TargetPlatform = 'win32' | 'macos' | 'linux';
export type TargetArch     = 'x64'   | 'arm64';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Align v up to the next multiple of a (a must be a power of two). */
const al = (v: number, a: number): number => (v + a - 1) & -a;

const enc = new TextEncoder();

/**
 * Write a 64-bit LE uint using two 32-bit writes.
 * Safe for values ≤ 2^53 (all realistic file offsets and sizes).
 */
function writeU64(dv: DataView, off: number, val: number): void {
  dv.setUint32(off,     val >>> 0,                     true);
  dv.setUint32(off + 4, Math.floor(val / 0x100000000), true);
}

/** Zero a char[len] field and write an ASCII string (no overflow). */
function setStr(buf: Uint8Array, off: number, str: string, len: number): void {
  buf.fill(0, off, off + len);
  buf.set(enc.encode(str.substring(0, len)), off);
}

function concat(arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let ofs = 0;
  for (const a of arrays) { out.set(a, ofs); ofs += a.length; }
  return out;
}

function hostArch(): TargetArch {
  if (process.arch === 'x64')   return 'x64';
  if (process.arch === 'arm64') return 'arm64';
  throw new Error(`Unsupported host architecture: ${process.arch}`);
}

export function hostPlatform(): TargetPlatform {
  switch (process.platform) {
    case 'win32':  return 'win32';
    case 'darwin': return 'macos';
    case 'linux':  return 'linux';
    default: throw new Error(`Unsupported platform: ${process.platform}`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Windows — COFF
// ═══════════════════════════════════════════════════════════════════════════════
//
// Packed struct layout  (all little-endian, "Coff" = 190 bytes):
//
//   CoffHeader        20  @ 0
//   CoffSection[0]    40  @ 20   (.drectve)
//   CoffSection[1]    40  @ 60   (.rdata)
//   CoffSymbol        18  @ 100  (.rdata section symbol)
//   CoffAuxSymbol     18  @ 118
//   CoffSymbol        18  @ 136  (.drectve section symbol)
//   CoffAuxSymbol     18  @ 154
//   CoffSymbol        18  @ 172  (@feat.00)
//
// File layout: [hd:190][symd:N×18][tsd:strTable][tsed:directives+pad][dsd:data]
//
// Symbol table starts at file offset 100 (= ffi.offsetof('Coff','rdata')).
// The 5 built-in entries live inside hd[100..189]; the N per-export entries
// follow immediately in symd, making the table contiguous.

const COFF_TOTAL_SZ       = 190;
const COFF_OFFSETOF_RDATA = 100;   // ffi.offsetof('Coff', 'rdata')
const COFF_SYM_SZ         = 18;
const COFF_HDR_SZ         = 20;
const COFF_SECT_SZ        = 40;

function doObjectWindows(symbols: ObjSymbol[], arch: TargetArch): Uint8Array {
  let strTabSz = 0, dataSz = 0;
  const directives: string[] = [];

  for (const { name, obj } of symbols) {
    strTabSz += name.length + 1;
    directives.push(` /EXPORT:${name},DATA`);
    if      (obj instanceof Uint8Array) dataSz += al(obj.length, 8);
    else if (typeof obj === 'string')   dataSz += al(obj.length + 1, 8);
    else if (typeof obj === 'number')   dataSz += 8;
    else throw new Error('Invalid symbol type');
  }

  const tsd  = new Uint8Array(strTabSz + 4);              // COFF string table
  const dsd  = new Uint8Array(dataSz);                    // .rdata data
  const tsed = enc.encode(directives.join(''));            // .drectve content
  const symd = new Uint8Array(COFF_SYM_SZ * symbols.length); // per-export symbols

  const tsddv  = new DataView(tsd.buffer);
  const dsddv  = new DataView(dsd.buffer);
  const symdv  = new DataView(symd.buffer);

  tsddv.setUint32(0, strTabSz + 4, true);  // string table size prefix

  let strOff = 4, dataOff = 0;

  for (let i = 0; i < symbols.length; i++) {
    const { name, obj } = symbols[i]!;
    const b = i * COFF_SYM_SZ;

    // CoffSymbol: long name (zeros=0 means use string table, offset=strOff)
    symdv.setUint32(b + 0,  0,       true);  // name.zeros
    symdv.setUint32(b + 4,  strOff,  true);  // name.offset  → string table
    symdv.setUint32(b + 8,  dataOff, true);  // value        = offset in .rdata
    symdv.setInt16( b + 12, 2,       true);  // sectionNumber: .rdata = 2
    symdv.setUint16(b + 14, 0,       true);  // type
    symd[b + 16] = 0x2;                       // storageClass: IMAGE_SYM_CLASS_EXTERNAL
    symd[b + 17] = 0;                         // numberOfAuxSymbols

    tsd.set(enc.encode(name), strOff);
    strOff += name.length + 1;

    if (obj instanceof Uint8Array) {
      dsd.set(obj, dataOff);
      dataOff += al(obj.length, 8);
    } else if (typeof obj === 'string') {
      dsd.set(enc.encode(obj), dataOff);
      dataOff += al(obj.length + 1, 8);
    } else if (typeof obj === 'number') {
      dsddv.setFloat64(dataOff, obj, true);
      dataOff += 8;
    }
  }

  // ── Coff header struct ──────────────────────────────────────────────────────

  const hd    = new Uint8Array(COFF_TOTAL_SZ);
  const hddv  = new DataView(hd.buffer);
  const machine = arch === 'x64' ? 0x8664 : 0xaa64;
  const ts      = Math.floor(Date.now() / 1000);

  // CoffHeader @ 0
  hddv.setUint16(0,  machine,             true);
  hddv.setUint16(2,  2,                   true);  // numberOfSections
  hddv.setUint32(4,  ts,                  true);  // timeDateStamp
  hddv.setUint32(8,  COFF_OFFSETOF_RDATA, true);  // pointerToSymbolTable
  hddv.setUint32(12, symbols.length + 5,  true);  // numberOfSymbols (5 built-in + N exports)
  // sizeOfOptionalHeader=0, flags=0  (zeroed)

  // CoffSection[0]: .drectve @ 20
  const drectvePtr = COFF_TOTAL_SZ + symd.length + tsd.length;
  setStr(hd, COFF_HDR_SZ, '.drectve', 8);
  hddv.setUint32(COFF_HDR_SZ + 16, tsed.length,  true);  // sizeOfRawData
  hddv.setUint32(COFF_HDR_SZ + 20, drectvePtr,   true);  // pointerToRawData
  hddv.setUint32(COFF_HDR_SZ + 36, 0x00100a00,   true);  // flags

  // CoffSection[1]: .rdata @ 60
  const rdataPtr = al(COFF_TOTAL_SZ + symd.length + tsd.length + tsed.length, 8);
  setStr(hd, COFF_HDR_SZ + COFF_SECT_SZ, '.rdata', 8);
  hddv.setUint32(COFF_HDR_SZ + COFF_SECT_SZ + 16, dsd.length,  true);
  hddv.setUint32(COFF_HDR_SZ + COFF_SECT_SZ + 20, rdataPtr,    true);
  hddv.setUint32(COFF_HDR_SZ + COFF_SECT_SZ + 36, 0x40300040,  true);

  // CoffSymbol: .rdata section symbol @ 100
  setStr(hd, 100, '.rdata', 8);
  hddv.setInt16(100 + 12, 2,  true);  // sectionNumber
  hd[100 + 16] = 0x3;                  // storageClass: IMAGE_SYM_CLASS_STATIC
  hd[100 + 17] = 1;                    // numberOfAuxSymbols

  // CoffAuxSymbol for .rdata @ 118
  hddv.setUint32(118 + 0,  dsd.length, true);  // length
  hddv.setUint16(118 + 12, 2,          true);  // number (= section index)

  // CoffSymbol: .drectve section symbol @ 136
  setStr(hd, 136, '.drectve', 8);
  hddv.setInt16(136 + 12, 1,  true);
  hd[136 + 16] = 0x3;
  hd[136 + 17] = 1;

  // CoffAuxSymbol for .drectve @ 154
  hddv.setUint32(154 + 0,  tsed.length, true);
  hddv.setUint16(154 + 12, 1,           true);

  // CoffSymbol: @feat.00 @ 172
  setStr(hd, 172, '@feat.00', 8);
  hddv.setInt16(172 + 12, -1, true);  // IMAGE_SYM_ABSOLUTE
  hd[172 + 16] = 0x3;

  // Pad tsed to 8-byte boundary so .rdata starts aligned
  const pad       = rdataPtr - (COFF_TOTAL_SZ + symd.length + tsd.length + tsed.length);
  const tsedFinal = pad > 0 ? concat([tsed, new Uint8Array(pad)]) : tsed;

  return concat([hd, symd, tsd, tsedFinal, dsd]);
}

// ═══════════════════════════════════════════════════════════════════════════════
// macOS — Mach-O
// ═══════════════════════════════════════════════════════════════════════════════
//
// mach_obj struct layout  (total 0x188 = 392 bytes):
//
//   mach_header_64            32  @ 0
//   mach_load_segment_cmd     72  @ 32
//   mach_section_64 __text    80  @ 104
//   mach_section_64 __const   80  @ 184
//   mach_minimun_os_command   24  @ 264
//   mach_symtab_command       24  @ 288
//   mach_symtab_info          80  @ 312
//
// File layout: [hd:0x188][dt:data][nti:symEntries][nt:stringTable]
//
// mach_sym_entry:  u32 strx | u8 type | u8 sect | u16 desc | u64 value = 16 bytes
// String table:    '\0' | ('_' + name + '\0') × N  — first byte is always null

const MACH_HDR_SZ = 0x188;  // = 392

// Byte offsets within hd
const MH   = 0;    // mach_header_64
const MSEG = 32;   // mach_load_segment_command
const MS1  = 104;  // mach_section_64[0]  __text  (empty)
const MS2  = 184;  // mach_section_64[1]  __const (data)
const MMO  = 264;  // mach_minimun_os_command
const MSYM = 288;  // mach_symtab_command
const MDYS = 312;  // mach_symtab_info  (LC_DYSYMTAB)

function doObjectMacOS(symbols: ObjSymbol[], arch: TargetArch): Uint8Array {
  let dataSz = 0, strTabSz = 1, symTabSz = 0;

  for (const { name, obj } of symbols) {
    if      (obj instanceof Uint8Array) dataSz += al(obj.length, 16);
    else if (typeof obj === 'string')   dataSz += al(obj.length,  16);  // raw bytes, no null
    else if (typeof obj === 'number')   dataSz += al(8, 16);            // = 16
    else throw new Error('Invalid symbol type');
    strTabSz += name.length + 2;  // '_' + name + '\0'
    symTabSz += 16;               // sizeof(mach_sym_entry)
  }
  strTabSz = al(strTabSz, 8);

  const dt  = new Uint8Array(dataSz);    // data section
  const nt  = new Uint8Array(strTabSz);  // string table  (first byte is '\0' by alloc)
  const nti = new Uint8Array(symTabSz);  // symbol entries

  const dtdv  = new DataView(dt.buffer);
  const ntidv = new DataView(nti.buffer);

  let dataOff = 0, strOff = 1;

  for (let k = 0; k < symbols.length; k++) {
    const { name, obj } = symbols[k]!;
    const valueInSection = dataOff;

    if (obj instanceof Uint8Array) {
      dt.set(obj, dataOff);
      dataOff += al(obj.length, 16);
    } else if (typeof obj === 'string') {
      dt.set(enc.encode(obj), dataOff);
      dataOff += al(obj.length, 16);
    } else if (typeof obj === 'number') {
      dtdv.setFloat64(dataOff, obj, true);
      dataOff += al(8, 16);
    }

    nt.set(enc.encode('_' + name), strOff);  // null terminator from Uint8Array zero-fill

    // mach_sym_entry @ k*16
    const e = k * 16;
    ntidv.setUint32(e + 0, strOff, true);  // strx
    nti[e + 4] = 0xf;                       // type: N_SECT | N_EXT
    nti[e + 5] = 2;                          // sect: 2 = __const
    ntidv.setUint16(e + 6, 0, true);        // desc
    writeU64(ntidv, e + 8, valueInSection); // value = offset within section

    strOff += name.length + 2;
  }

  const hd   = new Uint8Array(MACH_HDR_SZ);
  const hddv = new DataView(hd.buffer);

  // mach_header_64
  hddv.setUint32(MH + 0,  0xfeedfacf,                              true);  // MH_MAGIC_64
  hddv.setUint32(MH + 4,  arch === 'x64' ? 0x1000007 : 0x100000c, true);  // cputype
  hddv.setUint32(MH + 8,  arch === 'x64' ? 0x3        : 0x0,       true);  // cpusubtype
  hddv.setUint32(MH + 12, 0x1,   true);  // filetype: MH_OBJECT
  hddv.setUint32(MH + 16, 4,     true);  // ncmds: 4 load commands
  hddv.setUint32(MH + 20, 0x168, true);  // sizeofcmds = 0xE8+0x18+0x18+0x50 = 360
  hddv.setUint32(MH + 24, 0x200, true);  // flags: MH_SUBSECTIONS_VIA_SYMBOLS

  // LC_SEGMENT_64  (cmd=0x19, cmdsize=0xE8 = 72 + 80×2)
  hddv.setUint32(MSEG + 0, 0x19, true);
  hddv.setUint32(MSEG + 4, 0xE8, true);
  // segname[16]: all zeros = unnamed segment (correct for .o files)
  writeU64(hddv, MSEG + 24, 0);             // vmaddr
  writeU64(hddv, MSEG + 32, dataSz);        // vmsize
  writeU64(hddv, MSEG + 40, MACH_HDR_SZ);  // fileoff
  writeU64(hddv, MSEG + 48, dataSz);        // filesize
  hddv.setUint32(MSEG + 56, 0x7, true);     // maxprot:  PROT_READ|WRITE|EXEC
  hddv.setUint32(MSEG + 60, 0x7, true);     // initprot
  hddv.setUint32(MSEG + 64, 2,   true);     // nsects

  // mach_section_64[0]: __text  (empty — placeholder for the TEXT segment)
  setStr(hd, MS1 + 0,  '__text', 16);
  setStr(hd, MS1 + 16, '__TEXT', 16);
  // addr=0, size=0  (zeroed)
  hddv.setUint32(MS1 + 48, MACH_HDR_SZ,  true);  // offset
  // align=0
  hddv.setUint32(MS1 + 64, 0x80000000,   true);  // flags: S_ATTR_PURE_INSTRUCTIONS

  // mach_section_64[1]: __const  (actual exported data)
  setStr(hd, MS2 + 0,  '__const', 16);
  setStr(hd, MS2 + 16, '__TEXT',  16);
  // addr=0  (zeroed)
  writeU64(hddv, MS2 + 40, dataSz);              // size
  hddv.setUint32(MS2 + 48, MACH_HDR_SZ, true);  // offset
  hddv.setUint32(MS2 + 52, 0x02,        true);  // align: 2^2 = 4 bytes

  // LC_BUILD_VERSION  (cmd=0x32)
  hddv.setUint32(MMO + 0,  0x32,    true);
  hddv.setUint32(MMO + 4,  0x18,    true);
  hddv.setUint32(MMO + 8,  0x1,     true);   // platform: PLATFORM_MACOS
  hddv.setUint32(MMO + 12, 0xa0900, true);   // minos: 10.9.0
  hddv.setUint32(MMO + 16, 0xa0900, true);   // sdk:   10.9.0

  // LC_SYMTAB  (cmd=0x2)
  hddv.setUint32(MSYM + 0,  0x2,                            true);
  hddv.setUint32(MSYM + 4,  0x18,                           true);
  hddv.setUint32(MSYM + 8,  MACH_HDR_SZ + dataSz,          true);  // symoff
  hddv.setUint32(MSYM + 12, symbols.length,                 true);  // nsyms
  hddv.setUint32(MSYM + 16, MACH_HDR_SZ + dataSz + symTabSz, true);  // stroff
  hddv.setUint32(MSYM + 20, strTabSz,                       true);  // strsize

  // LC_DYSYMTAB  (cmd=0xb)
  hddv.setUint32(MDYS + 0,  0xb,            true);
  hddv.setUint32(MDYS + 4,  0x50,           true);
  // localoff=0, nlocals=0  (zeroed)
  hddv.setUint32(MDYS + 20, symbols.length, true);  // nextdef
  hddv.setUint32(MDYS + 24, symbols.length, true);  // undefoff

  return concat([hd, dt, nti, nt]);
}

// ═══════════════════════════════════════════════════════════════════════════════
// Linux — ELF64
// ═══════════════════════════════════════════════════════════════════════════════
//
// ELF64 struct layout  (total 448 bytes):
//
//   ELF64Header      64  @ 0
//   ELF64Section×6   64  @ 64…447
//     [0] null
//     [1] .symtab
//     [2] .strtab   (combined: section names followed by symbol names)
//     [3] .rodata
//     [4] .note.GNU-stack
//     [5] (unused)
//
// ELF64Symbol: u32 name | u8 info | u8 other | u16 sectidx | u64 value | u64 size = 24 bytes
//
// File layout: [hd:448][symd:symTable][ts:strTable][d:data]
//
// .strtab (section 2) is also used as .shstrtab (shstridx=2):
// it starts with section names (\0.symtab\0.strtab\0.rodata\0.note.GNU-stack\0)
// immediately followed by the exported symbol names.  Both the linker and the
// section-header string lookup use offsets into this single buffer.

const ELF_STRUCT_SZ = 448;
const ELF_HDR_SZ    = 64;
const ELF_SECT_SZ   = 64;
const ELF_SYM_SZ    = 24;

// ELF64Section field offsets within one section entry
const ES = { NAME:0, TYPE:4, FLAGS:8, ADDR:16, OFS:24, SIZE:32, LINK:40, INFO:44, ALIGN:48, ENTSZ:56 };
// ELF64Symbol field offsets
const EY = { NAME:0, INFO:4, OTHER:5, SECTIDX:6, VALUE:8, SIZE:16 };

const sectOfs = (idx: number): number => ELF_HDR_SZ + idx * ELF_SECT_SZ;

function doObjectLinux(symbols: ObjSymbol[], arch: TargetArch): Uint8Array {
  const SH_NAMES = '\0.symtab\0.strtab\0.rodata\0.note.GNU-stack\0';
  //               idx: 0   1        9        17       25
  const I_SYMTAB = 1, I_STRTAB = 9, I_RODATA = 17, I_NOTE = 25;

  let dataSz = 0, strTabSz = SH_NAMES.length;

  for (const { name, obj } of symbols) {
    strTabSz += name.length + 1;
    if      (obj instanceof Uint8Array) dataSz += al(obj.length, 8);
    else if (typeof obj === 'string')   dataSz += al(obj.length + 1, 8);
    else if (typeof obj === 'number')   dataSz += 8;
    else throw new Error('Invalid symbol type');
  }

  // Symbol table: one null entry (index 0) + one per export
  const symd = new Uint8Array(al(ELF_SYM_SZ * (symbols.length + 1), 16));
  const ts   = new Uint8Array(al(strTabSz, 16));
  const d    = new Uint8Array(al(dataSz, 16));

  const symdv = new DataView(symd.buffer);
  const ddv   = new DataView(d.buffer);

  ts.set(enc.encode(SH_NAMES), 0);

  let strOff = SH_NAMES.length, dataOff = 0;

  for (let k = 0; k < symbols.length; k++) {
    const { name, obj } = symbols[k]!;
    const sb = (k + 1) * ELF_SYM_SZ;  // skip null symbol at index 0

    symdv.setUint32(sb + EY.NAME,    strOff, true);
    symd[sb + EY.INFO]  = 0x11;              // STB_GLOBAL|STT_OBJECT = (1<<4)|1
    symd[sb + EY.OTHER] = 0;
    symdv.setUint16(sb + EY.SECTIDX, 3,     true);  // .rodata = section 3
    writeU64(symdv, sb + EY.VALUE, dataOff);

    ts.set(enc.encode(name), strOff);
    strOff += name.length + 1;

    if (obj instanceof Uint8Array) {
      d.set(obj, dataOff);
      writeU64(symdv, sb + EY.SIZE, obj.length);
      dataOff += al(obj.length, 8);
    } else if (typeof obj === 'string') {
      d.set(enc.encode(obj), dataOff);
      writeU64(symdv, sb + EY.SIZE, obj.length + 1);
      dataOff += al(obj.length + 1, 8);
    } else if (typeof obj === 'number') {
      ddv.setFloat64(dataOff, obj, true);
      writeU64(symdv, sb + EY.SIZE, 8);
      dataOff += 8;
    }
  }

  // ── ELF header + section headers ───────────────────────────────────────────

  const hd   = new Uint8Array(ELF_STRUCT_SZ);
  const hddv = new DataView(hd.buffer);
  const mach = arch === 'x64' ? 0x3e : 0xb7;

  // ELF64Header @ 0
  hd.set([0x7f, 0x45, 0x4c, 0x46], 0);  // \x7fELF
  hd[4] = 2;  // EI_CLASS:   ELFCLASS64
  hd[5] = 1;  // EI_DATA:    ELFDATA2LSB
  hd[6] = 1;  // EI_VERSION: EV_CURRENT
  // osabi=0, abiversion=0, epad=0
  hddv.setUint16(16, 1,    true);  // e_type:    ET_REL
  hddv.setUint16(18, mach, true);  // e_machine
  hddv.setUint32(20, 1,    true);  // e_version: EV_CURRENT
  // e_entry=0, e_phoff=0  (zeroed)
  writeU64(hddv, 40, ELF_HDR_SZ);           // e_shoff: section headers right after hdr
  // e_flags=0  (zeroed)
  hddv.setUint16(52, ELF_HDR_SZ,  true);    // e_ehsize
  // e_phentsize=0, e_phnum=0  (zeroed)
  hddv.setUint16(58, ELF_SECT_SZ, true);    // e_shentsize
  hddv.setUint16(60, 6,           true);    // e_shnum
  hddv.setUint16(62, 2,           true);    // e_shstrndx: .strtab = section 2

  const symtabOfs = ELF_STRUCT_SZ;
  const strtabOfs = ELF_STRUCT_SZ + symd.length;
  const rodataOfs = ELF_STRUCT_SZ + symd.length + ts.length;
  const noteOfs   = ELF_STRUCT_SZ + symd.length + ts.length + d.length;

  // Section[0]: null  (all zeros)

  // Section[1]: .symtab
  const s1 = sectOfs(1);
  hddv.setUint32(s1 + ES.NAME, I_SYMTAB, true);
  hddv.setUint32(s1 + ES.TYPE, 2,        true);  // SHT_SYMTAB
  writeU64(hddv, s1 + ES.OFS,   symtabOfs);
  writeU64(hddv, s1 + ES.SIZE,  symd.length);
  hddv.setUint32(s1 + ES.LINK, 2, true);         // associated .strtab = section 2
  hddv.setUint32(s1 + ES.INFO, 1, true);         // first global symbol index
  writeU64(hddv, s1 + ES.ALIGN, 8);
  writeU64(hddv, s1 + ES.ENTSZ, ELF_SYM_SZ);

  // Section[2]: .strtab
  const s2 = sectOfs(2);
  hddv.setUint32(s2 + ES.NAME, I_STRTAB, true);
  hddv.setUint32(s2 + ES.TYPE, 3,        true);  // SHT_STRTAB
  writeU64(hddv, s2 + ES.OFS,  strtabOfs);
  writeU64(hddv, s2 + ES.SIZE, ts.length);

  // Section[3]: .rodata
  const s3 = sectOfs(3);
  hddv.setUint32(s3 + ES.NAME, I_RODATA, true);
  hddv.setUint32(s3 + ES.TYPE, 1,        true);  // SHT_PROGBITS
  writeU64(hddv, s3 + ES.FLAGS, 2);              // SHF_ALLOC
  writeU64(hddv, s3 + ES.OFS,   rodataOfs);
  writeU64(hddv, s3 + ES.SIZE,  d.length);

  // Section[4]: .note.GNU-stack  (empty; signals non-executable stack to linker)
  const s4 = sectOfs(4);
  hddv.setUint32(s4 + ES.NAME, I_NOTE, true);
  hddv.setUint32(s4 + ES.TYPE, 1,      true);    // SHT_PROGBITS
  writeU64(hddv, s4 + ES.OFS, noteOfs);
  // size=0, flags=0  (zeroed)

  return concat([hd, symd, ts, d]);
}

// ═══════════════════════════════════════════════════════════════════════════════
// Public API  (mirrors object:encodeObject / object:encodeSymbols in Lua)
// ═══════════════════════════════════════════════════════════════════════════════

function dispatch(
  symbols:  ObjSymbol[],
  arch:     TargetArch     = hostArch(),
  platform: TargetPlatform = hostPlatform(),
): Uint8Array {
  switch (platform) {
    case 'win32': return doObjectWindows(symbols, arch);
    case 'macos': return doObjectMacOS(symbols, arch);
    case 'linux': return doObjectLinux(symbols, arch);
    default: throw new Error(`Unsupported platform: ${platform}`);
  }
}

/** Encode a single named symbol into a native linkable object file. */
export function encodeObject(
  name:      string,
  obj:       SymbolValue,
  arch?:     TargetArch,
  platform?: TargetPlatform,
): Uint8Array {
  return dispatch([{ name, obj }], arch, platform);
}

/** Encode multiple named symbols into a native linkable object file. */
export function encodeSymbols(
  symbols:   ObjSymbol[],
  arch?:     TargetArch,
  platform?: TargetPlatform,
): Uint8Array {
  return dispatch(symbols, arch, platform);
}