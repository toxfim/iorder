import { createLazyMessages } from './lazy-messages';

// The prose of the three "system" pages (activity history, bot settings, profile), merged at the
// root under `activityHistory`, `botSettings` and `staffProfile` after a dynamic import, only for
// the staff area.
export const ensureStaffSystemPagesMessages = createLazyMessages(null, {
  uz: async () => {
    const [history, bot, profile] = await Promise.all([
      import('@/features/activity-history/messages/uz'),
      import('@/features/bot-settings/messages/uz'),
      import('@/features/profile/messages/uz'),
    ]);
    return {
      activityHistory: history.activityHistoryUz,
      botSettings: bot.botSettingsUz,
      staffProfile: profile.staffProfileUz,
    };
  },
  ru: async () => {
    const [history, bot, profile] = await Promise.all([
      import('@/features/activity-history/messages/ru'),
      import('@/features/bot-settings/messages/ru'),
      import('@/features/profile/messages/ru'),
    ]);
    return {
      activityHistory: history.activityHistoryRu,
      botSettings: bot.botSettingsRu,
      staffProfile: profile.staffProfileRu,
    };
  },
  en: async () => {
    const [history, bot, profile] = await Promise.all([
      import('@/features/activity-history/messages/en'),
      import('@/features/bot-settings/messages/en'),
      import('@/features/profile/messages/en'),
    ]);
    return {
      activityHistory: history.activityHistoryEn,
      botSettings: bot.botSettingsEn,
      staffProfile: profile.staffProfileEn,
    };
  },
});
