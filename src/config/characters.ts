import type { CharacterId } from '../../shared/characters';
import orangeManifest from '../../assets/characters/manifest.json';
import deepseekManifest from '../../assets/characters/deepseek/manifest.json';

/**
 * Art for each selectable character. To add one: put its pictures and manifest.json in
 * assets/characters/<id>/, add the id to shared/characters.ts and a line here.
 */
export interface CharacterArt {
  /** Folder under assets/characters ('' = the folder itself). */
  dir: string;
  manifest: Record<string, unknown>;
}

export const CHARACTER_ART: Record<CharacterId, CharacterArt> = {
  orange: { dir: '', manifest: orangeManifest as Record<string, unknown> },
  deepseek: { dir: 'deepseek', manifest: deepseekManifest as Record<string, unknown> },
};
