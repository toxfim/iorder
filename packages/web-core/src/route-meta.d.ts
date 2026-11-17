import 'vue-router';

// The route fields the shared code reads; each app adds its own (route group, roles).
declare module 'vue-router' {
  interface RouteMeta {
    /** Message key for the page title (use-document-title). */
    titleKey?: string;
  }
}
