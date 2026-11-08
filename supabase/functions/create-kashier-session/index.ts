import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function requiredEnv(name: string) {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    console.error("Kashier session configuration is incomplete.");
    return jsonResponse({ error: "Payment service is not configured" }, 500);
  }

  const adminClient = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  let payload: { order_code?: unknown; normalized_phone?: unknown };
  try {
    payload = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid request body" }, 400);
  }
  const orderCode = typeof payload.order_code === "string" ? payload.order_code : "";
  const normalizedPhone = typeof payload.normalized_phone === "string" ? payload.normalized_phone : "";
  if (!/^HZ-[A-F0-9]{12}$/.test(orderCode) || !/^[0-9]{10,15}$/.test(normalizedPhone)) {
    return jsonResponse({ error: "Invalid order details" }, 400);
  }

  const { data: order, error: orderError } = await adminClient
    .from("store_orders")
    .select("code,normalized_phone,payment_method,customer_email,total,status,kashier_session_url,kashier_session_expires_at")
    .eq("code", orderCode)
    .eq("normalized_phone", normalizedPhone)
    .maybeSingle();
  if (orderError) {
    console.error("Could not load the Kashier order:", orderError.message);
    return jsonResponse({ error: "Could not load this order" }, 500);
  }
  if (!order || order.payment_method !== "kashier") return jsonResponse({ error: "Order not found" }, 404);
  if (order.status !== "بانتظار تأكيد الدفع") return jsonResponse({ error: "This order is not awaiting payment" }, 409);

  if (order.kashier_session_url && order.kashier_session_expires_at && new Date(order.kashier_session_expires_at).getTime() > Date.now()) {
    return jsonResponse({ sessionUrl: order.kashier_session_url });
  }
  if (order.kashier_session_url) {
    const { error: expiredOrderError } = await adminClient
      .from("store_orders")
      .update({ status: "تعذر تأكيد الدفع" })
      .eq("code", order.code)
      .eq("status", "بانتظار تأكيد الدفع");
    if (expiredOrderError) console.error("Could not close the expired Kashier order:", expiredOrderError.message);
    return jsonResponse({ error: "This payment session expired. Place a new order." }, 409);
  }

  const total = Number(order.total);
  if (!Number.isFinite(total) || total <= 0 || !order.customer_email) {
    console.error("Kashier order has invalid payment details:", order.code);
    return jsonResponse({ error: "This order cannot be paid online" }, 400);
  }

  let sessionUrl: string;
  let sessionId: string | null = null;
  const sessionExpiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
  try {
    const mode = Deno.env.get("KASHIER_MODE") || "test";
    if (mode !== "test") throw new Error("Live Kashier payments are disabled until server-side price validation is implemented");
    const apiBase = "https://test-api.kashier.io";
    const redirect = new URL(requiredEnv("KASHIER_MERCHANT_REDIRECT"));
    if (redirect.protocol !== "https:") throw new Error("KASHIER_MERCHANT_REDIRECT must use HTTPS");
    redirect.searchParams.set("payment_return", "kashier");

    const response = await fetch(`${apiBase}/v3/payment/sessions`, {
      method: "POST",
      headers: {
        Authorization: requiredEnv("KASHIER_SECRET_KEY"),
        "api-key": requiredEnv("KASHIER_API_KEY"),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        expireAt: sessionExpiresAt,
        maxFailureAttempts: 3,
        paymentType: "credit",
        amount: total.toFixed(2),
        currency: "EGP",
        order: order.code,
        merchantRedirect: redirect.toString(),
        display: "ar",
        type: "one-time",
        allowedMethods: "card",
        merchantId: requiredEnv("KASHIER_MERCHANT_ID"),
        defaultMethod: "card",
        failureRedirect: true,
        description: `Store order ${order.code}`,
        customer: { email: order.customer_email, reference: order.normalized_phone },
        serverWebhook: `${supabaseUrl.replace(/\/+$/, "")}/functions/v1/kashier-webhook`,
        enable3DS: true,
      }),
    });
    const responseBody = await response.json().catch(() => null);
    if (!response.ok) {
      console.error("Kashier rejected session creation:", response.status);
      throw new Error("Kashier could not create the payment session");
    }

    const result = responseBody?.data ?? responseBody;
    sessionUrl = typeof result?.sessionUrl === "string" ? result.sessionUrl : "";
    sessionId = typeof result?.sessionId === "string" ? result.sessionId : null;
    const parsedSessionUrl = new URL(sessionUrl);
    if (parsedSessionUrl.protocol !== "https:" || parsedSessionUrl.hostname !== "payments.kashier.io") {
      throw new Error("Kashier returned an invalid payment URL");
    }
  } catch (error) {
    console.error("Could not create Kashier payment session:", error);
    const { data: existingSession, error: existingSessionError } = await adminClient
      .from("store_orders")
      .select("kashier_session_url,kashier_session_expires_at,status")
      .eq("code", order.code)
      .maybeSingle();
    if (existingSessionError) console.error("Could not check for a concurrent Kashier session:", existingSessionError.message);
    if (
      existingSession?.status === "بانتظار تأكيد الدفع"
      && existingSession.kashier_session_url
      && existingSession.kashier_session_expires_at
      && new Date(existingSession.kashier_session_expires_at).getTime() > Date.now()
    ) {
      return jsonResponse({ sessionUrl: existingSession.kashier_session_url });
    }
    const { error: updateError } = await adminClient
      .from("store_orders")
      .update({ status: "تعذر تأكيد الدفع" })
      .eq("code", order.code)
      .eq("status", "بانتظار تأكيد الدفع");
    if (updateError) console.error("Could not release points for the failed Kashier order:", updateError.message);
    return jsonResponse({ error: "Could not prepare the Kashier payment session" }, 502);
  }

  const { data: savedSession, error: updateError } = await adminClient
    .from("store_orders")
    .update({
      kashier_session_id: sessionId,
      kashier_session_url: sessionUrl,
      kashier_session_expires_at: sessionExpiresAt,
    })
    .eq("code", order.code)
    .eq("status", "بانتظار تأكيد الدفع")
    .is("kashier_session_url", null)
    .select("kashier_session_url")
    .maybeSingle();
  if (updateError) {
    console.error("Could not save the Kashier payment session:", updateError.message);
    const { error: closeOrderError } = await adminClient
      .from("store_orders")
      .update({ status: "تعذر تأكيد الدفع" })
      .eq("code", order.code)
      .eq("status", "بانتظار تأكيد الدفع");
    if (closeOrderError) console.error("Could not close the order after session persistence failed:", closeOrderError.message);
    return jsonResponse({ error: "Could not save the payment session" }, 500);
  }
  if (!savedSession) {
    const { data: existingSession, error: existingSessionError } = await adminClient
      .from("store_orders")
      .select("kashier_session_url,kashier_session_expires_at,status")
      .eq("code", order.code)
      .maybeSingle();
    if (existingSessionError) {
      console.error("Could not check the existing Kashier payment session:", existingSessionError.message);
      return jsonResponse({ error: "Could not verify the payment session" }, 500);
    }
    if (
      existingSession?.status === "بانتظار تأكيد الدفع"
      && existingSession.kashier_session_url
      && existingSession.kashier_session_expires_at
      && new Date(existingSession.kashier_session_expires_at).getTime() > Date.now()
    ) {
      return jsonResponse({ sessionUrl: existingSession.kashier_session_url });
    }
    return jsonResponse({ error: "This order is no longer awaiting payment" }, 409);
  }

  return jsonResponse({ sessionUrl });
});
