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

export type SymbolValue = Buffer | string | number;

export interface ObjSymbol {
  name: string;
  obj:  SymbolValue;
}

export type TargetPlatform = 'win32' | 'darwin' | 'linux';
export type TargetArch     = 'x64'   | 'arm64';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Align v up to the next multiple of a (a must be a power of two). */
const al = (v: number, a: number): number => (v + a - 1) & -a;

/**
 * Write a 64-bit LE uint using two 32-bit writes.
 * Safe for values ≤ 2^53 (all realistic file offsets and sizes).
 */
function writeU64(buf: Buffer, off: number, val: number): void {
  buf.writeUInt32LE(val >>> 0,                      off);
  buf.writeUInt32LE(Math.floor(val / 0x100000000),  off + 4);
}

/** Zero a char[len] field and write an ASCII string (no overflow). */
function setStr(buf: Buffer, off: number, str: string, len: number): void {
  buf.fill(0, off, off + len);
  buf.write(str.substring(0, len), off, 'ascii');
}

function hostArch(): TargetArch {
  if (process.arch === 'x64')   return 'x64';
  if (process.arch === 'arm64') return 'arm64';
  throw new Error(`Unsupported host architecture: ${process.arch}`);
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

function doObjectWindows(symbols: ObjSymbol[], arch: TargetArch): Buffer {
  let strTabSz = 0, dataSz = 0;
  const directives: string[] = [];

  for (const { name, obj } of symbols) {
    strTabSz += name.length + 1;
    directives.push(` /EXPORT:${name},DATA`);
    if      (Buffer.isBuffer(obj))      dataSz += al(obj.length, 8);
    else if (typeof obj === 'string')   dataSz += al(obj.length + 1, 8);
    else if (typeof obj === 'number')   dataSz += 8;
    else throw new Error('Invalid symbol type');
  }

  const tsd  = Buffer.alloc(strTabSz + 4);              // COFF string table
  const dsd  = Buffer.alloc(dataSz);                    // .rdata data
  const tsed = Buffer.from(directives.join(''), 'ascii'); // .drectve content
  const symd = Buffer.alloc(COFF_SYM_SZ * symbols.length); // per-export symbols

  tsd.writeUInt32LE(strTabSz + 4, 0);  // string table size prefix

  let strOff = 4, dataOff = 0;

  for (let i = 0; i < symbols.length; i++) {
    const { name, obj } = symbols[i]!;
    const b = i * COFF_SYM_SZ;

    // CoffSymbol: long name (zeros=0 means use string table, offset=strOff)
    symd.writeUInt32LE(0,        b + 0);   // name.zeros
    symd.writeUInt32LE(strOff,   b + 4);   // name.offset  → string table
    symd.writeUInt32LE(dataOff,  b + 8);   // value        = offset in .rdata
    symd.writeInt16LE(2,         b + 12);  // sectionNumber: .rdata = 2
    symd.writeUInt16LE(0,        b + 14);  // type
    symd.writeUInt8(0x2,         b + 16);  // storageClass: IMAGE_SYM_CLASS_EXTERNAL
    symd.writeUInt8(0,           b + 17);  // numberOfAuxSymbols

    tsd.write(name, strOff, 'ascii');
    strOff += name.length + 1;

    if (Buffer.isBuffer(obj)) {
      obj.copy(dsd, dataOff);
      dataOff += al(obj.length, 8);
    } else if (typeof obj === 'string') {
      dsd.write(obj, dataOff, 'ascii');
      dataOff += al(obj.length + 1, 8);
    } else if (typeof obj === 'number') {
      dsd.writeDoubleLE(obj, dataOff);
      dataOff += 8;
    }
  }

  // ── Coff header struct ──────────────────────────────────────────────────────

  const hd      = Buffer.alloc(COFF_TOTAL_SZ);
  const machine = arch === 'x64' ? 0x8664 : 0xaa64;
  const ts      = Math.floor(Date.now() / 1000);

  // CoffHeader @ 0
  hd.writeUInt16LE(machine,              0);
  hd.writeUInt16LE(2,                    2);   // numberOfSections
  hd.writeUInt32LE(ts,                   4);   // timeDateStamp
  hd.writeUInt32LE(COFF_OFFSETOF_RDATA,  8);   // pointerToSymbolTable
  hd.writeUInt32LE(symbols.length + 5,  12);   // numberOfSymbols (5 built-in + N exports)
  // sizeOfOptionalHeader=0, flags=0  (zeroed)

  // CoffSection[0]: .drectve @ 20
  const drectvePtr = COFF_TOTAL_SZ + symd.length + tsd.length;
  setStr(hd, COFF_HDR_SZ, '.drectve', 8);
  hd.writeUInt32LE(tsed.length,    COFF_HDR_SZ + 16);  // sizeOfRawData
  hd.writeUInt32LE(drectvePtr,     COFF_HDR_SZ + 20);  // pointerToRawData
  hd.writeUInt32LE(0x00100a00,     COFF_HDR_SZ + 36);  // flags

  // CoffSection[1]: .rdata @ 60
  const rdataPtr = al(COFF_TOTAL_SZ + symd.length + tsd.length + tsed.length, 8);
  setStr(hd, COFF_HDR_SZ + COFF_SECT_SZ, '.rdata', 8);
  hd.writeUInt32LE(dsd.length,  COFF_HDR_SZ + COFF_SECT_SZ + 16);
  hd.writeUInt32LE(rdataPtr,    COFF_HDR_SZ + COFF_SECT_SZ + 20);
  hd.writeUInt32LE(0x40300040,  COFF_HDR_SZ + COFF_SECT_SZ + 36);

  // CoffSymbol: .rdata section symbol @ 100
  setStr(hd, 100, '.rdata', 8);
  hd.writeInt16LE(2,   100 + 12);  // sectionNumber
  hd.writeUInt8(0x3,  100 + 16);  // storageClass: IMAGE_SYM_CLASS_STATIC
  hd.writeUInt8(1,    100 + 17);  // numberOfAuxSymbols

  // CoffAuxSymbol for .rdata @ 118
  hd.writeUInt32LE(dsd.length, 118 + 0);   // length
  hd.writeUInt16LE(2,          118 + 12);  // number (= section index)

  // CoffSymbol: .drectve section symbol @ 136
  setStr(hd, 136, '.drectve', 8);
  hd.writeInt16LE(1,   136 + 12);
  hd.writeUInt8(0x3,  136 + 16);
  hd.writeUInt8(1,    136 + 17);

  // CoffAuxSymbol for .drectve @ 154
  hd.writeUInt32LE(tsed.length, 154 + 0);
  hd.writeUInt16LE(1,           154 + 12);

  // CoffSymbol: @feat.00 @ 172
  setStr(hd, 172, '@feat.00', 8);
  hd.writeInt16LE(-1,  172 + 12);  // IMAGE_SYM_ABSOLUTE
  hd.writeUInt8(0x3,  172 + 16);

  // Pad tsed to 8-byte boundary so .rdata starts aligned
  const pad       = rdataPtr - (COFF_TOTAL_SZ + symd.length + tsd.length + tsed.length);
  const tsedFinal = pad > 0 ? Buffer.concat([tsed, Buffer.alloc(pad)]) : tsed;

  return Buffer.concat([hd, symd, tsd, tsedFinal, dsd]);
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

function doObjectMacOS(symbols: ObjSymbol[], arch: TargetArch): Buffer {
  let dataSz = 0, strTabSz = 1, symTabSz = 0;

  for (const { name, obj } of symbols) {
    if      (Buffer.isBuffer(obj))    dataSz += al(obj.length, 16);
    else if (typeof obj === 'string') dataSz += al(obj.length,  16);  // raw bytes, no null
    else if (typeof obj === 'number') dataSz += al(8, 16);            // = 16
    else throw new Error('Invalid symbol type');
    strTabSz += name.length + 2;  // '_' + name + '\0'
    symTabSz += 16;               // sizeof(mach_sym_entry)
  }
  strTabSz = al(strTabSz, 8);

  const dt  = Buffer.alloc(dataSz);    // data section
  const nt  = Buffer.alloc(strTabSz);  // string table  (first byte is '\0' by alloc)
  const nti = Buffer.alloc(symTabSz);  // symbol entries

  let dataOff = 0, strOff = 1;

  for (let k = 0; k < symbols.length; k++) {
    const { name, obj } = symbols[k]!;
    const valueInSection = dataOff;

    if (Buffer.isBuffer(obj)) {
      obj.copy(dt, dataOff);
      dataOff += al(obj.length, 16);
    } else if (typeof obj === 'string') {
      dt.write(obj, dataOff, 'ascii');
      dataOff += al(obj.length, 16);
    } else if (typeof obj === 'number') {
      dt.writeDoubleLE(obj, dataOff);
      dataOff += al(8, 16);
    }

    nt.write('_' + name, strOff, 'ascii');  // null terminator from Buffer.alloc

    // mach_sym_entry @ k*16
    const e = k * 16;
    nti.writeUInt32LE(strOff, e + 0);  // strx
    nti.writeUInt8(0xf,       e + 4);  // type: N_SECT | N_EXT
    nti.writeUInt8(2,         e + 5);  // sect: 2 = __const
    nti.writeUInt16LE(0,      e + 6);  // desc
    writeU64(nti, e + 8, valueInSection);  // value = offset within section

    strOff += name.length + 2;
  }

  const hd = Buffer.alloc(MACH_HDR_SZ);

  // mach_header_64
  hd.writeUInt32LE(0xfeedfacf, MH + 0);  // MH_MAGIC_64
  hd.writeUInt32LE(arch === 'x64' ? 0x1000007 : 0x100000c, MH + 4);   // cputype
  hd.writeUInt32LE(arch === 'x64' ? 0x3        : 0x0,       MH + 8);   // cpusubtype
  hd.writeUInt32LE(0x1,   MH + 12);  // filetype: MH_OBJECT
  hd.writeUInt32LE(4,     MH + 16);  // ncmds: 4 load commands
  hd.writeUInt32LE(0x168, MH + 20);  // sizeofcmds = 0xE8+0x18+0x18+0x50 = 360
  hd.writeUInt32LE(0x200, MH + 24);  // flags: MH_SUBSECTIONS_VIA_SYMBOLS

  // LC_SEGMENT_64  (cmd=0x19, cmdsize=0xE8 = 72 + 80×2)
  hd.writeUInt32LE(0x19, MSEG + 0);
  hd.writeUInt32LE(0xE8, MSEG + 4);
  // segname[16]: all zeros = unnamed segment (correct for .o files)
  writeU64(hd, MSEG + 24, 0);             // vmaddr
  writeU64(hd, MSEG + 32, dataSz);        // vmsize
  writeU64(hd, MSEG + 40, MACH_HDR_SZ);  // fileoff
  writeU64(hd, MSEG + 48, dataSz);        // filesize
  hd.writeUInt32LE(0x7, MSEG + 56);       // maxprot:  PROT_READ|WRITE|EXEC
  hd.writeUInt32LE(0x7, MSEG + 60);       // initprot
  hd.writeUInt32LE(2,   MSEG + 64);       // nsects

  // mach_section_64[0]: __text  (empty — placeholder for the TEXT segment)
  setStr(hd, MS1 + 0,  '__text', 16);
  setStr(hd, MS1 + 16, '__TEXT', 16);
  // addr=0, size=0  (zeroed)
  hd.writeUInt32LE(MACH_HDR_SZ, MS1 + 48);    // offset
  // align=0
  hd.writeUInt32LE(0x80000000, MS1 + 64);      // flags: S_ATTR_PURE_INSTRUCTIONS

  // mach_section_64[1]: __const  (actual exported data)
  setStr(hd, MS2 + 0,  '__const', 16);
  setStr(hd, MS2 + 16, '__TEXT',  16);
  // addr=0  (zeroed)
  writeU64(hd, MS2 + 40, dataSz);              // size
  hd.writeUInt32LE(MACH_HDR_SZ, MS2 + 48);    // offset
  hd.writeUInt32LE(0x02, MS2 + 52);            // align: 2^2 = 4 bytes

  // LC_BUILD_VERSION  (cmd=0x32)
  hd.writeUInt32LE(0x32,    MMO + 0);
  hd.writeUInt32LE(0x18,    MMO + 4);
  hd.writeUInt32LE(0x1,     MMO + 8);   // platform: PLATFORM_MACOS
  hd.writeUInt32LE(0xa0900, MMO + 12);  // minos: 10.9.0
  hd.writeUInt32LE(0xa0900, MMO + 16);  // sdk:   10.9.0

  // LC_SYMTAB  (cmd=0x2)
  hd.writeUInt32LE(0x2,                       MSYM + 0);
  hd.writeUInt32LE(0x18,                      MSYM + 4);
  hd.writeUInt32LE(MACH_HDR_SZ + dataSz,      MSYM + 8);   // symoff
  hd.writeUInt32LE(symbols.length,             MSYM + 12);  // nsyms
  hd.writeUInt32LE(MACH_HDR_SZ + dataSz + symTabSz, MSYM + 16);  // stroff
  hd.writeUInt32LE(strTabSz,                   MSYM + 20);  // strsize

  // LC_DYSYMTAB  (cmd=0xb)
  hd.writeUInt32LE(0xb,            MDYS + 0);
  hd.writeUInt32LE(0x50,           MDYS + 4);
  // localoff=0, nlocals=0  (zeroed)
  hd.writeUInt32LE(symbols.length, MDYS + 20);  // nextdef
  hd.writeUInt32LE(symbols.length, MDYS + 24);  // undefoff

  return Buffer.concat([hd, dt, nti, nt]);
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

function doObjectLinux(symbols: ObjSymbol[], arch: TargetArch): Buffer {
  const SH_NAMES = '\0.symtab\0.strtab\0.rodata\0.note.GNU-stack\0';
  //               idx: 0   1        9        17       25
  const I_SYMTAB = 1, I_STRTAB = 9, I_RODATA = 17, I_NOTE = 25;

  let dataSz = 0, strTabSz = SH_NAMES.length;

  for (const { name, obj } of symbols) {
    strTabSz += name.length + 1;
    if      (Buffer.isBuffer(obj))    dataSz += al(obj.length, 8);
    else if (typeof obj === 'string') dataSz += al(obj.length + 1, 8);
    else if (typeof obj === 'number') dataSz += 8;
    else throw new Error('Invalid symbol type');
  }

  // Symbol table: one null entry (index 0) + one per export
  const symd = Buffer.alloc(al(ELF_SYM_SZ * (symbols.length + 1), 16));
  const ts   = Buffer.alloc(al(strTabSz, 16));
  const d    = Buffer.alloc(al(dataSz, 16));

  ts.write(SH_NAMES, 0, 'ascii');

  let strOff = SH_NAMES.length, dataOff = 0;

  for (let k = 0; k < symbols.length; k++) {
    const { name, obj } = symbols[k]!;
    const sb = (k + 1) * ELF_SYM_SZ;  // skip null symbol at index 0

    symd.writeUInt32LE(strOff, sb + EY.NAME);
    symd.writeUInt8(0x11,      sb + EY.INFO);     // STB_GLOBAL|STT_OBJECT = (1<<4)|1
    symd.writeUInt8(0,         sb + EY.OTHER);
    symd.writeUInt16LE(3,      sb + EY.SECTIDX);  // .rodata = section 3
    writeU64(symd, sb + EY.VALUE, dataOff);

    ts.write(name, strOff, 'ascii');
    strOff += name.length + 1;

    if (Buffer.isBuffer(obj)) {
      obj.copy(d, dataOff);
      writeU64(symd, sb + EY.SIZE, obj.length);
      dataOff += al(obj.length, 8);
    } else if (typeof obj === 'string') {
      d.write(obj, dataOff, 'ascii');
      writeU64(symd, sb + EY.SIZE, obj.length + 1);
      dataOff += al(obj.length + 1, 8);
    } else if (typeof obj === 'number') {
      d.writeDoubleLE(obj, dataOff);
      writeU64(symd, sb + EY.SIZE, 8);
      dataOff += 8;
    }
  }

  // ── ELF header + section headers ───────────────────────────────────────────

  const hd    = Buffer.alloc(ELF_STRUCT_SZ);
  const mach  = arch === 'x64' ? 0x3e : 0xb7;

  // ELF64Header @ 0
  hd.write('\x7fELF', 0, 'ascii');
  hd.writeUInt8(2, 4);   // EI_CLASS:   ELFCLASS64
  hd.writeUInt8(1, 5);   // EI_DATA:    ELFDATA2LSB
  hd.writeUInt8(1, 6);   // EI_VERSION: EV_CURRENT
  // osabi=0, abiversion=0, epad=0
  hd.writeUInt16LE(1,      16);  // e_type:    ET_REL
  hd.writeUInt16LE(mach,   18);  // e_machine
  hd.writeUInt32LE(1,      20);  // e_version: EV_CURRENT
  // e_entry=0, e_phoff=0  (zeroed)
  writeU64(hd, 40, ELF_HDR_SZ);          // e_shoff: section headers right after hdr
  // e_flags=0  (zeroed)
  hd.writeUInt16LE(ELF_HDR_SZ,  52);     // e_ehsize
  // e_phentsize=0, e_phnum=0  (zeroed)
  hd.writeUInt16LE(ELF_SECT_SZ, 58);     // e_shentsize
  hd.writeUInt16LE(6,            60);     // e_shnum
  hd.writeUInt16LE(2,            62);     // e_shstrndx: .strtab = section 2

  const symtabOfs = ELF_STRUCT_SZ;
  const strtabOfs = ELF_STRUCT_SZ + symd.length;
  const rodataOfs = ELF_STRUCT_SZ + symd.length + ts.length;
  const noteOfs   = ELF_STRUCT_SZ + symd.length + ts.length + d.length;

  // Section[0]: null  (all zeros)

  // Section[1]: .symtab
  const s1 = sectOfs(1);
  hd.writeUInt32LE(I_SYMTAB,  s1 + ES.NAME);
  hd.writeUInt32LE(2,         s1 + ES.TYPE);   // SHT_SYMTAB
  writeU64(hd, s1 + ES.OFS,   symtabOfs);
  writeU64(hd, s1 + ES.SIZE,  symd.length);
  hd.writeUInt32LE(2,         s1 + ES.LINK);   // associated .strtab = section 2
  hd.writeUInt32LE(1,         s1 + ES.INFO);   // first global symbol index
  writeU64(hd, s1 + ES.ALIGN, 8);
  writeU64(hd, s1 + ES.ENTSZ, ELF_SYM_SZ);

  // Section[2]: .strtab
  const s2 = sectOfs(2);
  hd.writeUInt32LE(I_STRTAB,  s2 + ES.NAME);
  hd.writeUInt32LE(3,         s2 + ES.TYPE);   // SHT_STRTAB
  writeU64(hd, s2 + ES.OFS,   strtabOfs);
  writeU64(hd, s2 + ES.SIZE,  ts.length);

  // Section[3]: .rodata
  const s3 = sectOfs(3);
  hd.writeUInt32LE(I_RODATA,  s3 + ES.NAME);
  hd.writeUInt32LE(1,         s3 + ES.TYPE);   // SHT_PROGBITS
  writeU64(hd, s3 + ES.FLAGS, 2);              // SHF_ALLOC
  writeU64(hd, s3 + ES.OFS,   rodataOfs);
  writeU64(hd, s3 + ES.SIZE,  d.length);

  // Section[4]: .note.GNU-stack  (empty; signals non-executable stack to linker)
  const s4 = sectOfs(4);
  hd.writeUInt32LE(I_NOTE,    s4 + ES.NAME);
  hd.writeUInt32LE(1,         s4 + ES.TYPE);   // SHT_PROGBITS
  writeU64(hd, s4 + ES.OFS,   noteOfs);
  // size=0, flags=0  (zeroed)

  return Buffer.concat([hd, symd, ts, d]);
}

// ═══════════════════════════════════════════════════════════════════════════════
// Public API  (mirrors object:encodeObject / object:encodeSymbols in Lua)
// ═══════════════════════════════════════════════════════════════════════════════

function dispatch(
  symbols:  ObjSymbol[],
  arch:     TargetArch     = hostArch(),
  platform: TargetPlatform = process.platform as TargetPlatform,
): Buffer {
  switch (platform) {
    case 'win32':  return doObjectWindows(symbols, arch);
    case 'darwin': return doObjectMacOS(symbols, arch);
    case 'linux':  return doObjectLinux(symbols, arch);
    default: throw new Error(`Unsupported platform: ${platform}`);
  }
}

/** Encode a single named symbol into a native linkable object file. */
export function encodeObject(
  name:      string,
  obj:       SymbolValue,
  arch?:     TargetArch,
  platform?: TargetPlatform,
): Buffer {
  return dispatch([{ name, obj }], arch, platform);
}

/** Encode multiple named symbols into a native linkable object file. */
export function encodeSymbols(
  symbols:   ObjSymbol[],
  arch?:     TargetArch,
  platform?: TargetPlatform,
): Buffer {
  return dispatch(symbols, arch, platform);
}