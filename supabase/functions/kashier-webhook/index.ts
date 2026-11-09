import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

type KashierWebhook = {
  event?: unknown;
  data?: Record<string, unknown> & { signatureKeys?: unknown };
};

function response(status: number) {
  return new Response(null, { status });
}

function encodeSignatureValue(value: unknown) {
  return encodeURIComponent(String(value)).replace(/[!'()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

function constantTimeEqual(left: string, right: string) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index++) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

async function verifySignature(data: Record<string, unknown>, suppliedSignature: string, apiKey: string) {
  const keys = data.signatureKeys;
  if (!Array.isArray(keys) || keys.length === 0 || keys.some((key) => typeof key !== "string")) return false;
  const sortedKeys = [...keys as string[]].sort();
  if (new Set(sortedKeys).size !== sortedKeys.length || sortedKeys.some((key) => !(key in data))) return false;
  const signaturePayload = sortedKeys.map((key) => `${key}=${encodeSignatureValue(data[key])}`).join("&");
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(apiKey),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(signaturePayload));
  const expectedSignature = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return constantTimeEqual(expectedSignature.toLowerCase(), suppliedSignature.toLowerCase());
}

Deno.serve(async (request) => {
  if (request.method !== "POST") return response(405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const paymentApiKey = Deno.env.get("KASHIER_API_KEY");
  const secretKey = Deno.env.get("KASHIER_SECRET_KEY");
  const merchantId = Deno.env.get("KASHIER_MERCHANT_ID");
  if (!supabaseUrl || !serviceRoleKey || !paymentApiKey || !secretKey || !merchantId) {
    console.error("Kashier webhook configuration is incomplete.");
    return response(500);
  }

  let payload: KashierWebhook;
  try {
    payload = await request.json();
  } catch {
    return response(400);
  }
  const data = payload.data;
  const signature = request.headers.get("x-kashier-signature");
  if (!data || !signature) return response(401);
  try {
    if (!await verifySignature(data, signature, paymentApiKey)) return response(401);
  } catch (error) {
    console.error("Could not verify the Kashier webhook signature:", error);
    return response(500);
  }

  if (payload.event !== "pay" && payload.event !== "capture") return response(200);
  if (data.method !== "card" || data.currency !== "EGP") return response(200);
  if (
    typeof data.orderReference !== "string"
    || !/^HZ-[A-F0-9]{12}$/.test(data.orderReference)
    || typeof data.merchantOrderId !== "string"
    || typeof data.transactionId !== "string"
  ) return response(200);
  if (data.status !== "SUCCESS" && data.status !== "FAILURE") return response(200);

  const adminClient = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: order, error: orderError } = await adminClient
    .from("store_orders")
    .select("code,payment_method,status,total")
    .eq("code", data.orderReference)
    .maybeSingle();
  if (orderError) {
    console.error("Could not load the order for the Kashier webhook:", orderError.message);
    return response(500);
  }
  if (!order || order.payment_method !== "kashier") return response(200);
  if (order.status === "تم تأكيد الدفع" || order.status === "تعذر تأكيد الدفع") return response(200);

  const mode = Deno.env.get("KASHIER_MODE") || "test";
  if (mode !== "test" && mode !== "live") {
    console.error("KASHIER_MODE must be test or live.");
    return response(500);
  }
  const apiBase = mode === "live" ? "https://api.kashier.io" : "https://test-api.kashier.io";
  let matchingOrder: Record<string, unknown> | undefined;
  try {
    const search = new URL(`${apiBase}/v3/payment/orders`);
    search.searchParams.set("search", data.merchantOrderId);
    const lookup = await fetch(search, { headers: { Authorization: secretKey } });
    if (!lookup.ok) {
      console.error("Kashier order verification failed:", lookup.status);
      return response(503);
    }
    const lookupBody = await lookup.json();
    const orders = Array.isArray(lookupBody?.data) ? lookupBody.data : [];
    matchingOrder = orders.find((entry: Record<string, unknown>) =>
      entry.merchantOrderId === data.merchantOrderId
      && entry.orderReference === order.code
    );
  } catch (error) {
    console.error("Could not verify the Kashier order:", error);
    return response(503);
  }
  if (!matchingOrder) return response(503);

  const kashierAmount = Number((matchingOrder.order as Record<string, unknown> | undefined)?.amount);
  const expectedAmount = Number(order.total);
  if (
    matchingOrder.merchantId !== merchantId
    || (matchingOrder.order as Record<string, unknown> | undefined)?.currency !== "EGP"
    || !Number.isFinite(kashierAmount)
    || Math.abs(kashierAmount - expectedAmount) > 0.001
  ) {
    console.error("Kashier payment does not match the stored order:", order.code);
    return response(200);
  }

  const transactions = Array.isArray(matchingOrder.transactions) ? matchingOrder.transactions : [];
  const transaction = transactions.find((entry: Record<string, unknown>) =>
    entry.transactionId === data.transactionId
    && entry.status === data.status
    && entry.currency === "EGP"
    && Math.abs(Number(entry.amount) - expectedAmount) <= 0.001
  );
  if (!transaction) {
    console.error("Kashier transaction details do not match the signed webhook:", order.code);
    return response(200);
  }

  const nextStatus = data.status === "SUCCESS" && matchingOrder.status === "CAPTURED"
    ? "تم تأكيد الدفع"
    : data.status === "FAILURE"
      && ["DECLINED", "FAILED", "EXPIRED", "CANCELLED"].includes(String(matchingOrder.status))
    ? "تعذر تأكيد الدفع"
    : null;
  if (!nextStatus) return response(200);

  const { error: updateError } = await adminClient
    .from("store_orders")
    .update({
      status: nextStatus,
      kashier_transaction_id: String(data.transactionId),
    })
    .eq("code", order.code)
    .eq("status", "بانتظار تأكيد الدفع");
  if (updateError) {
    console.error("Could not update the Kashier order status:", updateError.message);
    return response(500);
  }
  return response(200);
});
