/** Loads the lazy route components the screens tests navigate to, before the first click. */
export async function preloadRouteComponents(): Promise<void> {
  await Promise.all([
    import('@/features/staff-shell/components/StaffShell.vue'),
    import('@/features/dashboard/components/DashboardPage.vue'),
    import('@/features/staff-orders/components/OrdersPage.vue'),
    import('@/features/staff-orders/components/OrderDetailPage.vue'),
    import('@/features/staff-orders/components/AccountingQueuePage.vue'),
    import('@/features/staff-orders/components/WarehousePage.vue'),
    import('@/features/staff-orders/components/DriverDeliveriesPage.vue'),
  ]);
}
