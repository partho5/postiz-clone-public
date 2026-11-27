// AI video editing (ai.video-editing): the contract as the JSON `GET /public/v1/ai-edits/contract` serves and the
// phone bundles as `assets/aiedit/contract.json`. Built only from the contract modules next to it.
import {
  CONTRACT_VERSION,
  EditLevel,
  LEVEL_RULES,
  LevelRule,
  OUTPUTS,
  OutputRatio,
  OutputSpec,
  PaletteSpec,
  Phrase,
  PROTECTION,
  Protection,
  RegistryEntry,
  RoleDerivation,
  SoundId,
  SPEED_RULES,
  SpeedRules,
  TextFeature,
  TextLayer,
  TextLook,
  ZoneId,
  ZONES,
} from './edit.contract';
import { EFFECTS } from './edit.registry';
import { PHRASES } from './edit.phrases';
import { SOUND_IDS } from './edit.sounds';
import { PALETTE, ROLE_DERIVATION, TEXT_FEATURES, TEXT_LAYER_ORDER, TEXT_LOOKS } from './edit.styles';
import { allLookVectors, LookVectors } from './edit.vectors';

// The shape of the contract JSON.
export interface ContractView {
  contract_version: number;
  levels: Record<EditLevel, LevelRule>;
  speed: SpeedRules;
  protection: Protection;
  outputs: Record<OutputRatio, OutputSpec>;
  zones: Record<ZoneId, [number, number]>;
  effects: RegistryEntry[];
  text_styles: TextLook[];
  palette: PaletteSpec;
  // Additive keys installed phones ignore: how the derived colour roles are made, the layer order, the feature ids and
  // the conformance vectors generated from the look table (one entry per look).
  color_roles: RoleDerivation;
  text_layer_order: TextLayer[];
  text_features: TextFeature[];
  look_vectors: LookVectors[];
  phrases: Phrase[];
  sounds: SoundId[];
}

// The whole contract, in the order the task plan lists it. A fresh copy, so a caller cannot change the tables.
export const contractView = (): ContractView =>
  JSON.parse(
    JSON.stringify({
      contract_version: CONTRACT_VERSION,
      levels: LEVEL_RULES,
      speed: SPEED_RULES,
      protection: PROTECTION,
      outputs: OUTPUTS,
      zones: ZONES,
      effects: EFFECTS,
      text_styles: TEXT_LOOKS,
      palette: PALETTE,
      color_roles: ROLE_DERIVATION,
      text_layer_order: TEXT_LAYER_ORDER,
      text_features: TEXT_FEATURES,
      look_vectors: allLookVectors(TEXT_LOOKS),
      phrases: PHRASES,
      sounds: SOUND_IDS,
    })
  );
