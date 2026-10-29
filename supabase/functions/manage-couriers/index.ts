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

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  const authorization = request.headers.get("Authorization");
  if (!authorization?.startsWith("Bearer ")) return jsonResponse({ error: "Unauthorized" }, 401);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) return jsonResponse({ error: "Server configuration is missing" }, 500);

  const adminClient = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const accessToken = authorization.slice("Bearer ".length);
  const { data: authData, error: authError } = await adminClient.auth.getUser(accessToken);
  if (authError || !authData.user) return jsonResponse({ error: "Unauthorized" }, 401);

  const { data: admin, error: adminError } = await adminClient
    .from("store_admins")
    .select("user_id")
    .eq("user_id", authData.user.id)
    .maybeSingle();
  if (adminError) return jsonResponse({ error: "Could not verify admin access" }, 500);
  if (!admin) return jsonResponse({ error: "Admin access required" }, 403);

  let payload: { action?: string; name?: string; email?: string; password?: string };
  try {
    payload = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid request body" }, 400);
  }

  if (payload.action === "list") {
    const { data: staff, error: staffError } = await adminClient
      .from("store_delivery_staff")
      .select("user_id,created_at")
      .order("created_at", { ascending: false });
    if (staffError) return jsonResponse({ error: "Could not load delivery staff" }, 500);

    const couriers = await Promise.all((staff || []).map(async (member) => {
      const { data } = await adminClient.auth.admin.getUserById(member.user_id);
      return {
        user_id: member.user_id,
        created_at: member.created_at,
        email: data.user?.email || "",
        name: data.user?.user_metadata?.full_name || "",
      };
    }));
    return jsonResponse({ couriers });
  }

  if (payload.action !== "create") return jsonResponse({ error: "Unsupported action" }, 400);

  const name = payload.name?.trim() || "";
  const email = payload.email?.trim().toLowerCase() || "";
  const password = payload.password || "";
  if (name.length < 2 || name.length > 80) return jsonResponse({ error: "Name must be between 2 and 80 characters" }, 400);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) return jsonResponse({ error: "Enter a valid email address" }, 400);
  if (password.length < 12 || password.length > 128) return jsonResponse({ error: "Password must be between 12 and 128 characters" }, 400);

  const { data: created, error: createError } = await adminClient.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: name, account_type: "delivery" },
  });
  if (createError || !created.user) {
    const conflict = createError?.message.toLowerCase().includes("already") || createError?.message.toLowerCase().includes("registered");
    return jsonResponse({ error: conflict ? "An account with this email already exists" : createError?.message || "Could not create user" }, conflict ? 409 : 400);
  }

  const { error: staffError } = await adminClient
    .from("store_delivery_staff")
    .insert({ user_id: created.user.id });
  if (staffError) {
    await adminClient.auth.admin.deleteUser(created.user.id);
    return jsonResponse({ error: "Could not add user to delivery staff" }, 500);
  }

  return jsonResponse({
    courier: {
      user_id: created.user.id,
      email: created.user.email,
      name,
      created_at: created.user.created_at,
    },
  }, 201);
});