// Cost preview: what the publish dialog's confirm button says about its cost, and whether the cost
// holds it back: disabled while the cost is being asked or could not be stated, "Publish to N channels: M credits"
// once a price is known, and no change for a draft, a set or a free action.
export const publishCostButton = (
  req: {
    applies: boolean;
    channels: number;
    cost?: { amount: number };
    error?: unknown;
  },
  t: (key: string, fallback: string) => string
): { blocked: boolean; text?: string } => {
  if (!req.applies || req.channels === 0) {
    return { blocked: false };
  }
  if (!req.cost) {
    return {
      blocked: true,
      text: req.error ? t('cost_unavailable', 'Cost unavailable') : '…',
    };
  }
  if (req.cost.amount <= 0) {
    return { blocked: false };
  }
  // Own keys: `channels` is already the capitalised heading "Channels" in the locale files.
  const channels =
    req.channels === 1
      ? t('cost_channel', 'channel')
      : t('cost_channels', 'channels');
  const credits =
    req.cost.amount === 1 ? t('credit', 'credit') : t('credits', 'credits');
  return {
    blocked: false,
    text: `${t('cost_publish_to', 'Publish to')} ${req.channels} ${channels}: ${
      req.cost.amount
    } ${credits}`,
  };
};
