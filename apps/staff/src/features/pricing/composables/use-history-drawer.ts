import { ref, type Ref } from 'vue';
import { pickName, type LocalizedName } from '../domain/localized-name';

/** What the drawer header needs about a product. */
export interface DrawerProduct {
  readonly productId: string;
  readonly productCode: string;
  readonly names: readonly LocalizedName[];
}

/** State of the "price history" drawer opened from a table row. */
export function useHistoryDrawer(rows: Readonly<Ref<readonly DrawerProduct[]>>) {
  const open = ref(false);
  const productId = ref<string | null>(null);
  const info = ref({ productCode: '', name: '' });

  function openFor(id: string): void {
    const source = rows.value.find((candidate) => candidate.productId === id);
    if (!source) return;
    // The id is kept after the drawer closes so its content survives the exit animation.
    productId.value = id;
    info.value = { productCode: source.productCode, name: pickName(source.names) };
    open.value = true;
  }

  return { open, productId, info, openFor };
}
