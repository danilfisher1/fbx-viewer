/**
 * Минимальный разбор бинарного FBX: вшитые картинки (Video.Content) и связи
 * Material ← Texture ← Video. Нужен потому, что FBXLoader подключает только Diffuse,
 * а карты roughness / metallic / opacity НПМ (ShininessExponent, ReflectionFactor, …) молча выбрасывает.
 * Массивы (геометрия) не распаковываются — пропускаются по длине.
 */

export interface EmbeddedTexture {
  fileName: string;
  /** Через какое свойство материала подключена в FBX (DiffuseColor, ReflectionFactor, …). */
  slot: string;
  data: Uint8Array;
}

export interface EmbeddedMaterial {
  name: string;
  textures: EmbeddedTexture[];
}

type Prop = string | number | bigint | boolean | Uint8Array | null;
interface FbxNode {
  name: string;
  props: Prop[];
  children: FbxNode[];
}

const MAGIC = "Kaydara FBX Binary  \0";
const decoder = new TextDecoder();

export function parseEmbeddedMaterials(buffer: ArrayBuffer): EmbeddedMaterial[] {
  const bytes = new Uint8Array(buffer);
  if (decoder.decode(bytes.subarray(0, 21)) !== MAGIC) return [];
  const view = new DataView(buffer);
  const version = view.getUint32(23, true);
  const wide = version >= 7500;

  // Нужны только Objects (Material/Texture/Video) и Connections — остальное пропускаем целиком.
  const wanted = new Set(["Objects", "Connections", "Material", "Texture", "Video", "C", "RelativeFilename", "FileName", "Content"]);

  const readNode = (offset: number): { node: FbxNode | null; next: number } => {
    const end = wide ? Number(view.getBigUint64(offset, true)) : view.getUint32(offset, true);
    const numProps = wide ? Number(view.getBigUint64(offset + 8, true)) : view.getUint32(offset + 4, true);
    const nameLen = view.getUint8(offset + (wide ? 24 : 12));
    const head = offset + (wide ? 25 : 13);
    if (end === 0) return { node: null, next: head };
    const name = decoder.decode(bytes.subarray(head, head + nameLen));
    if (!wanted.has(name)) return { node: { name, props: [], children: [] }, next: end };

    let p = head + nameLen;
    const props: Prop[] = [];
    for (let i = 0; i < numProps; i++) {
      const t = String.fromCharCode(bytes[p++]);
      switch (t) {
        case "Y": props.push(view.getInt16(p, true)); p += 2; break;
        case "C": props.push(bytes[p] !== 0); p += 1; break;
        case "I": props.push(view.getInt32(p, true)); p += 4; break;
        case "F": props.push(view.getFloat32(p, true)); p += 4; break;
        case "D": props.push(view.getFloat64(p, true)); p += 8; break;
        case "L": props.push(view.getBigInt64(p, true)); p += 8; break;
        case "S": {
          const len = view.getUint32(p, true);
          props.push(decoder.decode(bytes.subarray(p + 4, p + 4 + len)));
          p += 4 + len;
          break;
        }
        case "R": {
          const len = view.getUint32(p, true);
          props.push(bytes.subarray(p + 4, p + 4 + len));
          p += 4 + len;
          break;
        }
        case "f": case "d": case "l": case "i": case "b": {
          const compressed = view.getUint32(p + 8, true);
          props.push(null);
          p += 12 + compressed;
          break;
        }
        default:
          return { node: { name, props, children: [] }, next: end };
      }
    }
    const children: FbxNode[] = [];
    while (p < end) {
      const r = readNode(p);
      if (!r.node) break;
      children.push(r.node);
      p = r.next;
    }
    return { node: { name, props, children }, next: end };
  };

  const top: FbxNode[] = [];
  let off = 27;
  while (off < bytes.length - 160) {
    const r = readNode(off);
    if (!r.node) break;
    top.push(r.node);
    off = r.next;
  }

  const objects = top.find((n) => n.name === "Objects")?.children ?? [];
  const connections = top.find((n) => n.name === "Connections")?.children ?? [];
  const cleanName = (s: Prop) => String(s ?? "").split("\0")[0].replace(/^(Material|Texture|Video)::/, "");
  const childProp = (n: FbxNode, key: string) => n.children.find((c) => c.name === key)?.props[0];
  const baseName = (s: string) => s.split(/[\\/]/).pop() ?? s;

  const videos = new Map<string, { fileName: string; data: Uint8Array }>();
  const textures = new Map<string, string>(); // texture id → имя файла
  const materials = new Map<string, string>(); // material id → имя
  for (const o of objects) {
    const id = String(o.props[0]);
    if (o.name === "Video") {
      const content = childProp(o, "Content");
      const file = String(childProp(o, "RelativeFilename") ?? childProp(o, "FileName") ?? cleanName(o.props[1]));
      if (content instanceof Uint8Array && content.length) videos.set(id, { fileName: baseName(file), data: content });
    } else if (o.name === "Texture") {
      const file = String(childProp(o, "RelativeFilename") ?? childProp(o, "FileName") ?? cleanName(o.props[1]));
      textures.set(id, baseName(file));
    } else if (o.name === "Material") {
      materials.set(id, cleanName(o.props[1]));
    }
  }

  const videoOfTexture = new Map<string, string>();
  const matTextures = new Map<string, { texId: string; slot: string }[]>();
  for (const c of connections) {
    const [kind, child, parent, slot] = c.props;
    const childId = String(child);
    const parentId = String(parent);
    if (videos.has(childId) && textures.has(parentId)) videoOfTexture.set(parentId, childId);
    else if (kind === "OP" && textures.has(childId) && materials.has(parentId)) {
      const list = matTextures.get(parentId) ?? [];
      list.push({ texId: childId, slot: String(slot ?? "") });
      matTextures.set(parentId, list);
    }
  }

  // Видео по имени файла — на случай, если связь Texture → Video не нашлась.
  const videoByFile = new Map(Array.from(videos.values()).map((v) => [v.fileName.toLowerCase(), v]));

  const out: EmbeddedMaterial[] = [];
  for (const [matId, name] of materials) {
    const list: EmbeddedTexture[] = [];
    for (const { texId, slot } of matTextures.get(matId) ?? []) {
      const vid = videos.get(videoOfTexture.get(texId) ?? "") ?? videoByFile.get((textures.get(texId) ?? "").toLowerCase());
      if (vid) list.push({ fileName: vid.fileName, slot, data: vid.data });
    }
    out.push({ name, textures: list });
  }
  return out;
}
