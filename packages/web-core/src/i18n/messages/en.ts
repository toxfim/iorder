import type { CoreMessageSchema } from './uz';

export const coreEn: CoreMessageSchema = {
  signIn: {
    journeySubmit: 'Place order',
    journeyAccepted: 'Your order has been received',
    journeyPacking: 'Packing your products',
    journeyLoading: 'Loading the truck',
    journeyDriving: 'Your order is on its way',
    journeyShop: 'YOUR SHOP',

    previewPlaced: 'Order placed',
    previewConfirmed: 'Order confirmed',
    previewDelivered: 'Delivered',

    login: 'Login',
    password: 'Password',
    loginPlaceholder: 'Enter your login',
    passwordPlaceholder: 'Enter your password',
    showPassword: 'Show password',
    hidePassword: 'Hide password',
    show: 'Show',
    hide: 'Hide',
    forgotPassword: 'Forgot password?',
    submit: 'Sign in',
    wait: 'Wait: {seconds} s',
    or: 'or',
    telegram: 'Continue with Telegram',
    telegramUnavailable: 'Telegram sign-in is not configured yet.',
    previewOrder: 'ORDER No. 1048',
    previewQuantity: '4 products · 12 units',
  },
  common: {
    currency: 'UZS',
    close: 'Close',
    /** Closes a dialog that only explains something. */
    understood: 'Got it',
    cancel: 'Cancel',
    undo: 'Undo',
    back: 'Back',
    language: 'Language',
    theme: 'Theme',
    themeSystem: 'System',
    themeLight: 'Light',
    themeDark: 'Dark',
    search: 'Search',
    /** The one sales unit (PIECE_UNIT): the company sells whole pieces only. */
    unitPiece: 'pcs',
  },
  state: {
    loading: 'Loading…',
    retry: 'Try again',
    reload: 'Reload',
    outdated: {
      title: 'Update needed',
      description: 'The app needs an update. Reload the page.',
    },
    empty: {
      title: 'No data yet',
      description: 'New data will appear here.',
    },
    error: {
      title: "Couldn't load",
      description: 'Check your connection and try again.',
    },
    denied: {
      title: 'No access',
      description: 'This page is closed for your role.',
    },
  },
  apiErrors: {
    denied: 'You do not have permission for this action.',
    timeout: 'The server did not answer in time. Try again.',
    network: 'No connection. Check your internet and try again.',
    invalidResponse: 'The server returned an unexpected answer. Try again later.',
    generic: 'The action could not be completed. Try again.',
    draftAlreadyOpen: 'A draft is already open. Publish or delete it first.',
    draftClosed:
      'This draft can no longer be edited: it was published or deleted. Refresh the page.',
    // One message per shared CONFLICT reason (see CONFLICT_REASON_MESSAGES).
    draftNotOpen: 'This draft has already been published. Refresh the page.',
    versionNotDraft: 'This version is not a draft and cannot be changed.',
    invalidTransition: 'The version status cannot be changed that way. Refresh the page.',
    emptyDraft: 'The draft is empty: price at least one product to publish it.',
    noPublishedVersion: 'There is no published list to copy. Create a blank draft.',
    anotherPublished: 'Another version was published first. Refresh the page and try again.',
    productCodeExists: 'This product ID already exists (letter case is ignored).',
    removalRequestNotPending: 'This removal request has already been decided.',
    orderChanged: 'The order was changed by someone else. Refresh the page and try again.',
    illegalOrderTransition: 'This action is not possible for the order in its current status.',
    orderNotEditable: 'The items of this order can no longer be edited.',
    paymentMethodNotChangeable: 'The payment method of this order can no longer be changed.',
    paymentPlanNotChangeable: 'The payment plan of this order can no longer be changed.',
    paymentPlanWindowEnded: 'The time to change the payment plan is over.',
    currencyConversionUnavailable:
      'The amount cannot be worked out right now. Please try again a little later.',
    cartTotalChanged:
      'The price changed, so the order was not placed. Check the new total and send it again.',
    deferredPriceUnavailable:
      'Paying in parts is not available: a product in this order has no such price.',
    emptyCart: 'The cart is empty.',
    productNotOrderable: 'Some products in the cart cannot be ordered right now.',
    stockLimitExceeded: 'There is not that much in stock. Lower the quantity in the cart.',
    stockLimitExceededOne: 'Only {count} pcs in stock. Lower the quantity.',
    stockLimitExceededNone: 'This product is out of stock.',
    idempotencyKeyReused: 'This order request was already sent by someone else.',
    orderingOrganizationInactive: 'This organization cannot place orders.',
    staffOrderingDisabled: 'Company employees cannot place orders here.',
    contactRequired: 'Enter your name and phone number first.',
    placerNotMember:
      'This person is no longer a member of the organization. Choose the customer again.',
    lastAdmin: 'The system must keep at least one active administrator.',
    telegramIdRequired: 'A person without a Telegram ID must stay a staff member.',
    organizationNotLinked:
      'This organization is not connected to Telegram yet: it activates itself when the customer uses the connect link.',
    organizationAlreadyLinked:
      'This organization is already connected to Telegram: no new link is needed.',
    personOrganization:
      'In a person organization the connected person is the only shop owner: their role cannot change.',
    organizationArchived:
      'This organization is archived: an administrator has to restore it before anything changes.',
    botNotConfigured: 'The Telegram bot is not set up yet. Please tell an administrator.',
    unitCodeDuplicate: 'This code is already recorded on another unit.',
    unitCodeNotRequired: 'This product does not take this code.',
    unitCodesNotEditable: 'Codes can be scanned only between the approval and the release.',
    goodsReturnNotPending: 'This order has no goods waiting to be returned.',
    allocationChanged: 'The stock changed. Check the new plan and confirm.',
    stockInsufficient: 'Not enough stock for this order.',
    supplyPartyConflict: 'Choose how to handle the party numbers already in place.',
    supplyPartyChanged: 'Another manager changed this party. Check the list and save again.',
    supplyNotAvailable: 'A chosen supply is no longer in the sheet.',
    allocationNotChangeable: 'Stock can no longer be held for this order.',
    unitCodesIncomplete: 'Some units still miss their codes. Scan them before releasing.',
    duplicateCategoryName: 'A category with this name already exists.',
    categoryArchived: 'This category is archived. Restore it or choose another one.',
    paymentVoided: 'This payment was voided and can no longer be changed.',
    priceListChanged:
      'The price list was updated by someone else meanwhile. The current prices were reloaded; check your changes and save again.',
    emptyPriceList: 'The price list cannot be left empty: keep at least one priced product.',
    reservedProductCodePrefix:
      'A code starting with "IO-" cannot be entered by hand: that prefix is for system-generated codes.',
    notGeneratedCode:
      'Only a product added by hand (without a sheet ID) can be linked to a sheet product.',
    targetIsGenerated: 'Choose a sheet product to link to, not one added by hand.',
    productAlreadyMerged:
      'This product is already linked to a sheet product and can no longer be changed.',
    sheetSyncQueueUnavailable:
      'Background jobs are switched off on this server: the sync cannot be started.',
    duplicateBrandName: 'A brand with this name already exists (letter case is ignored).',
    productImageDuplicate: 'This photo is already on the product.',
    primaryImageExists:
      'The product already has a main photo. Make the new photo main with its own button.',
    inactiveProducts:
      '{count} inactive product cannot be priced. Remove it from the draft. | {count} inactive products cannot be priced. Remove them from the draft.',
    inactiveInDraft:
      'The draft contains {count} inactive product. Remove it before publishing. | The draft contains {count} inactive products. Remove them before publishing.',
    conflict: 'The action conflicts with the current state. Refresh the page and try again.',
    unknownProducts: '{count} product was not found. | {count} products were not found.',
    notFound: 'Not found.',
    gone: 'This item no longer exists. Refresh the page.',
    validation: 'Some of the data is invalid. Check the rows marked in red.',
  },
  // Payment status (UNPAID / PAID): one wording for customers and staff alike.
  paymentStatus: { UNPAID: 'Unpaid', PAID: 'Paid' },
  telegramWidget: {
    unavailable: 'The Telegram button could not be loaded. Sign in with your login and password.',
  },
};
