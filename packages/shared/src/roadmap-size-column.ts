import { SIZE_LABELS, type SizeLabel } from './roadmap-schedule.js';

export const SIZE_COLUMN_NAME = 'Size';

/**
 * Per-size colors for the status-style "Size" pill — an effort heatmap from
 * green (smallest) to red (largest). Hexes are drawn from the board status
 * palette so the Size column looks at home next to Status.
 */
export const SIZE_COLORS: Record<SizeLabel, string> = {
  XXS: '#00C875',
  XS: '#9CD326',
  S: '#CAB641',
  M: '#FFCB00',
  L: '#FDAB3D',
  XL: '#FF642E',
  XXL: '#E44258',
};

export const SIZE_COLUMN_CONFIG: { options: string[]; optionColors: Record<string, string> } = {
  options: [...SIZE_LABELS],
  optionColors: SIZE_COLORS,
};
