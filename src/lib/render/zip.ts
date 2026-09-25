import { crc32 } from './crc32';

export interface ZipEntry { name: string; data: Buffer; modified?: Date }

function dosTime(d: Date): { time: number; date: number } {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/**
 * A stored (uncompressed) ZIP. Receipts are already-compressed PDFs and PNGs,
 * so deflating them again buys almost nothing; storing keeps this tiny and
 * obviously correct. Names are UTF-8 (flag bit 11). Duplicate names inside
 * the archive get a numeric suffix instead of silently overwriting.
 */
export function buildZip(entries: ZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  const used = new Set<string>();
  let offset = 0;

  for (const e of entries) {
    let name = e.name.replace(/^\/+/, '').replace(/\.\.(\/|$)/g, '');
    if (used.has(name.toLowerCase())) {
      const dot = name.lastIndexOf('.');
      let i = 2;
      while (used.has(`${dot > 0 ? name.slice(0, dot) : name} (${i})${dot > 0 ? name.slice(dot) : ''}`.toLowerCase())) i += 1;
      name = `${dot > 0 ? name.slice(0, dot) : name} (${i})${dot > 0 ? name.slice(dot) : ''}`;
    }
    used.add(name.toLowerCase());
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(e.data);
    const { time, date } = dosTime(e.modified ?? new Date());

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(e.data.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, e.data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(e.data.length, 20);
    central.writeUInt32LE(e.data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);

    offset += 30 + nameBuf.length + e.data.length;
  }

  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}
