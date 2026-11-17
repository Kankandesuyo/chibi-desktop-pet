import { DEFAULT_CHARACTER, isBuiltinCharacter, type BuiltinCharacterId, type CharacterId, type CustomCharacterInfo } from '../../shared/characters';
import orangeManifest from '../../assets/characters/manifest.json';
import deepseekManifest from '../../assets/characters/deepseek/manifest.json';

/**
 * Art for each built-in character. To add one: put its pictures and manifest.json in
 * assets/characters/<id>/, add the id to shared/characters.ts and a line here.
 * Users can also add characters without rebuilding: see docs/CUSTOM_CHARACTERS.md.
 */
export interface CharacterArt {
  /** Folder under assets/characters ('' = the folder itself). */
  dir: string;
  manifest: Record<string, unknown>;
}

export const CHARACTER_ART: Record<BuiltinCharacterId, CharacterArt> = {
  orange: { dir: '', manifest: orangeManifest as Record<string, unknown> },
  deepseek: { dir: 'deepseek', manifest: deepseekManifest as Record<string, unknown> },
};

/** Every PNG in assets/characters (and one folder per extra character) is picked up at build time. */
const FILE_URLS = import.meta.glob<string>('../../assets/characters/**/*.png', { eager: true, import: 'default', query: '?url' });
const ROOT = '../../assets/characters/';

/** URL of a user-made character's picture; the main process serves these from the characters folder. */
export function userCharacterUrl(folder: string, file: string): string {
  return `./user-characters/${encodeURIComponent(folder)}/${encodeURIComponent(file)}`;
}

/** What the sprite loader needs: the manifest and where each picture file can be fetched. */
export interface ResolvedArt {
  /** The character actually shown (a missing custom one falls back to the default). */
  character: CharacterId;
  manifest: Record<string, unknown>;
  urlByFile: Map<string, string>;
}

export function resolveCharacterArt(character: CharacterId, custom: readonly CustomCharacterInfo[] = []): ResolvedArt {
  if (!isBuiltinCharacter(character)) {
    const c = custom.find((x) => x.id === character && !x.error);
    if (c) return { character, manifest: c.manifest, urlByFile: new Map(c.files.map((f) => [f, userCharacterUrl(c.folder, f)])) };
    character = DEFAULT_CHARACTER;
  }
  const art = CHARACTER_ART[character];
  const prefix = art.dir ? `${ROOT}${art.dir}/` : ROOT;
  const urlByFile = new Map<string, string>();
  for (const [path, url] of Object.entries(FILE_URLS)) {
    const rest = path.startsWith(prefix) ? path.slice(prefix.length) : null;
    if (rest && !rest.includes('/')) urlByFile.set(rest, url);            // this character's own folder only
  }
  return { character, manifest: art.manifest, urlByFile };
}
