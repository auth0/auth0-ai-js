/** In-memory seed data for the store API. It resets when the process restarts. */

export interface OrderRecord {
  id: string;
  item: string;
  sku: string;
  qty: number;
  status: string;
}

export interface StoreData {
  orders: () => OrderRecord[];
  order: (id: string) => OrderRecord | undefined;
  stock: (sku: string) => number | undefined;
  /** Reserves stock once per order id. Returns undefined for an unknown sku. */
  reserve: (
    sku: string,
    qty: number,
    orderId: string,
  ) => { alreadyReserved: boolean; before: number; after: number } | undefined;
}

export function createStoreData(): StoreData {
  const orders: OrderRecord[] = [
    { id: "ORD-1001", item: "Wireless Headphones", sku: "SKU-HEAD-01", qty: 1, status: "shipped" },
    { id: "ORD-1002", item: "Mechanical Keyboard", sku: "SKU-KEYB-02", qty: 1, status: "processing" },
    { id: "ORD-1003", item: "USB-C Dock", sku: "SKU-DOCK-03", qty: 2, status: "processing" },
  ];
  const stock = new Map<string, number>([
    ["SKU-HEAD-01", 24],
    ["SKU-KEYB-02", 12],
    ["SKU-DOCK-03", 7],
  ]);
  const reserved = new Set<string>();

  return {
    orders: () => orders.map((o) => ({ ...o })),
    order: (id) => {
      const found = orders.find((o) => o.id === id);
      return found && { ...found };
    },
    stock: (sku) => stock.get(sku),
    reserve: (sku, qty, orderId) => {
      const before = stock.get(sku);
      if (before === undefined) return undefined;
      if (reserved.has(orderId)) {
        return { alreadyReserved: true, before, after: before };
      }
      reserved.add(orderId);
      stock.set(sku, before - qty);
      return { alreadyReserved: false, before, after: before - qty };
    },
  };
}
