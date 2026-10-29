/** In-memory seed data for the orders API. It resets when the process restarts. */

export interface OrderRecord {
  id: string;
  item: string;
  qty: number;
  status: "processing" | "shipped" | "cancelled";
}

export type CancelResult = "cancelled" | "already_cancelled" | "shipped" | "not_found";

export interface OrdersData {
  orders: () => OrderRecord[];
  /** Cancels an order that has not shipped. Cancelling twice is not an error. */
  cancel: (id: string) => CancelResult;
}

export function createOrdersData(): OrdersData {
  const orders: OrderRecord[] = [
    { id: "ord_1001", item: "Wireless Headphones", qty: 1, status: "shipped" },
    { id: "ord_1002", item: "Mechanical Keyboard", qty: 1, status: "processing" },
    { id: "ord_1003", item: "USB-C Dock", qty: 2, status: "processing" },
  ];

  return {
    orders: () => orders.map((order) => ({ ...order })),
    cancel: (id) => {
      const order = orders.find((candidate) => candidate.id === id);
      if (order === undefined) return "not_found";
      if (order.status === "shipped") return "shipped";
      if (order.status === "cancelled") return "already_cancelled";
      order.status = "cancelled";
      return "cancelled";
    },
  };
}
