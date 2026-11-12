const UPSTREAM_URL = "https://cheapsmmmarket.com/api/v2";
const MARKUP = 2.5;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, x-admin-passkey, Authorization",
  "Access-Control-Max-Age": "86400",
  "Content-Type": "application/json",
};

const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36",
  Accept: "application/json, text/plain, */*",
};

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: CORS_HEADERS,
  });
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function callUpstream(apiKey, params) {
  const payload = { key: apiKey, ...params };

  let res = await fetch(UPSTREAM_URL, {
    method: "POST",
    headers: {
      ...BROWSER_HEADERS,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(payload),
  });

  let rawText = await res.text();
  let parsed = safeJsonParse(rawText);

  if (!parsed || (typeof parsed === "object" && !Array.isArray(parsed) && parsed.error)) {
    const query = new URLSearchParams(payload).toString();
    res = await fetch(`${UPSTREAM_URL}?${query}`, {
      method: "GET",
      headers: BROWSER_HEADERS,
    });
    rawText = await res.text();
    parsed = safeJsonParse(rawText);
  }

  return { res, rawText, parsed };
}

async function fetchAndSyncServices(env) {
  const apiKey = String(env.CSM_API_KEY || "").trim();
  if (!apiKey) {
    throw new Error("CSM_API_KEY secret is missing in Cloudflare.");
  }

  const { res, rawText, parsed } = await callUpstream(apiKey, {
    action: "services",
  });

  if (!Array.isArray(parsed)) {
    const detail =
      parsed && parsed.error
        ? parsed.error
        : `HTTP ${res.status}: ${rawText.slice(0, 140)}`;
    throw new Error(`Upstream rejected request (${detail})`);
  }

  const markedUp = parsed.map((item) => ({
    ...item,
    rate: (parseFloat(item.rate || "0") * MARKUP).toFixed(4),
  }));

  if (env.DARK_STARK_DB) {
    await env.DARK_STARK_DB.put("services_cache", JSON.stringify(markedUp));
    await env.DARK_STARK_DB.put("last_sync", new Date().toISOString());
  }

  return markedUp;
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    try {
      if (path === "/") {
        return jsonResponse({
          status: "online",
          system: "Dark Stark SMM Edge Proxy",
          markup: MARKUP,
          endpoints: [
            "/api/services",
            "/api/orders/create",
            "/api/orders",
            "/api/deposits/submit",
            "/api/wallet",
            "/api/admin/sync",
            "/api/admin/deposits",
            "/api/admin/deposits/approve",
          ],
        });
      }

      if (path === "/api/services" && request.method === "GET") {
        const forceRefresh = url.searchParams.get("refresh") === "1";
        if (!forceRefresh && env.DARK_STARK_DB) {
          const cached = await env.DARK_STARK_DB.get("services_cache");
          if (cached) {
            return new Response(cached, { status: 200, headers: CORS_HEADERS });
          }
        }
        const services = await fetchAndSyncServices(env);
        return jsonResponse(services);
      }

      if (path === "/api/orders/create" && request.method === "POST") {
        const body = await request.json().catch(() => ({}));
        const { service, link, quantity, userId } = body;

        if (!service || !link || !quantity) {
          return jsonResponse(
            { success: false, error: "Service, link, and quantity are required." },
            400
          );
        }

        const apiKey = String(env.CSM_API_KEY || "").trim();
        if (!apiKey) {
          return jsonResponse(
            { success: false, error: "Server missing CSM_API_KEY." },
            500
          );
        }

        const qty = Number(quantity);
        if (!Number.isFinite(qty) || qty <= 0) {
          return jsonResponse(
            { success: false, error: "Invalid order quantity." },
            400
          );
        }

        let services = [];
        if (env.DARK_STARK_DB) {
          const cached = await env.DARK_STARK_DB.get("services_cache");
          services = cached ? safeJsonParse(cached) || [] : [];
        }
        if (services.length === 0) {
          services = await fetchAndSyncServices(env);
        }

        const matchedService = services.find(
          (s) => String(s.service) === String(service)
        );
        const unitRate = matchedService
          ? parseFloat(matchedService.rate || "0")
          : 0;
        const exactCharge = Number(((qty / 1000) * unitRate).toFixed(4));
        const uid = String(userId || "default_user").trim();

        if (env.DARK_STARK_DB && exactCharge > 0) {
          const balKey = `balance_${uid}`;
          const currentBal = parseFloat(
            (await env.DARK_STARK_DB.get(balKey)) || "0"
          );
          if (currentBal < exactCharge) {
            return jsonResponse(
              {
                success: false,
                error: `Insufficient balance (${currentBal.toFixed(
                  2
                )} available, ${exactCharge.toFixed(2)} required).`,
              },
              400
            );
          }
        }

        const { parsed: upstreamData, rawText } = await callUpstream(apiKey, {
          action: "add",
          service: String(service),
          link: String(link).trim(),
          quantity: String(qty),
        });

        if (!upstreamData || upstreamData.error || !upstreamData.order) {
          const errMsg =
            upstreamData && upstreamData.error
              ? upstreamData.error
              : `Upstream order failed: ${rawText.slice(0, 120)}`;
          return jsonResponse({ success: false, error: errMsg }, 400);
        }

        const orderRecord = {
          orderId: String(upstreamData.order),
          service: String(service),
          serviceName: matchedService ? matchedService.name : `Service #${service}`,
          link: String(link).trim(),
          quantity: qty,
          charge: exactCharge,
          userId: uid,
          status: "Processing",
          createdAt: new Date().toISOString(),
        };

        if (env.DARK_STARK_DB) {
          const existing =
            safeJsonParse((await env.DARK_STARK_DB.get("orders")) || "[]") || [];
          existing.unshift(orderRecord);
          await env.DARK_STARK_DB.put("orders", JSON.stringify(existing));

          if (exactCharge > 0) {
            const balKey = `balance_${uid}`;
            const currentBal = parseFloat(
              (await env.DARK_STARK_DB.get(balKey)) || "0"
            );
            const nextBal = Math.max(0, currentBal - exactCharge);
            await env.DARK_STARK_DB.put(balKey, nextBal.toFixed(4));
          }
        }

        return jsonResponse({
          success: true,
          order: orderRecord.orderId,
          details: orderRecord,
        });
      }

      if (path === "/api/orders" && request.method === "GET") {
        const uid = url.searchParams.get("userId");
        const allOrders = env.DARK_STARK_DB
          ? safeJsonParse((await env.DARK_STARK_DB.get("orders")) || "[]") || []
          : [];
        const filtered = uid
          ? allOrders.filter((o) => o.userId === String(uid).trim())
          : allOrders;
        return jsonResponse({ success: true, orders: filtered });
      }

      if (path === "/api/deposits/submit" && request.method === "POST") {
        const body = await request.json().catch(() => ({}));
        const { amount, transactionId, paymentMethod, userId } = body;
        const parsedAmount = parseFloat(amount);

        if (!Number.isFinite(parsedAmount) || parsedAmount <= 0 || !transactionId) {
          return jsonResponse(
            {
              success: false,
              error: "Valid amount and Transaction ID are required.",
            },
            400
          );
        }

        const deposit = {
          id: `DEP-${Date.now()}`,
          amount: parsedAmount,
          transactionId: String(transactionId).trim(),
          paymentMethod: String(paymentMethod || "UPI").trim(),
          userId: String(userId || "default_user").trim(),
          status: "Pending Verification",
          createdAt: new Date().toISOString(),
        };

        if (env.DARK_STARK_DB) {
          const deposits =
            safeJsonParse((await env.DARK_STARK_DB.get("deposits")) || "[]") ||
            [];
          deposits.unshift(deposit);
          await env.DARK_STARK_DB.put("deposits", JSON.stringify(deposits));
        }

        return jsonResponse({ success: true, deposit });
      }

      if (path === "/api/wallet" && request.method === "GET") {
        const uid = String(
          url.searchParams.get("userId") || "default_user"
        ).trim();
        const balance = env.DARK_STARK_DB
          ? parseFloat((await env.DARK_STARK_DB.get(`balance_${uid}`)) || "0")
          : 0;
        const allDeposits = env.DARK_STARK_DB
          ? safeJsonParse((await env.DARK_STARK_DB.get("deposits")) || "[]") ||
            []
          : [];
        const userDeposits = allDeposits.filter((d) => d.userId === uid);
        return jsonResponse({
          success: true,
          userId: uid,
          balance,
          deposits: userDeposits,
        });
      }

      if (path.startsWith("/api/admin")) {
        const body =
          request.method === "POST"
            ? await request.json().catch(() => ({}))
            : {};
        const providedKey = String(
          request.headers.get("x-admin-passkey") || body.passkey || ""
        ).trim();
        const expectedKey = String(env.ADMIN_PASSKEY || "").trim();

        if (!expectedKey || providedKey !== expectedKey) {
          return jsonResponse(
            { success: false, error: "Unauthorized: Invalid Admin Passkey." },
            401
          );
        }

        if (path === "/api/admin/sync" && request.method === "POST") {
          const services = await fetchAndSyncServices(env);
          return jsonResponse({ success: true, count: services.length });
        }

        if (path === "/api/admin/deposits" && request.method === "GET") {
          const deposits = env.DARK_STARK_DB
            ? safeJsonParse((await env.DARK_STARK_DB.get("deposits")) || "[]") ||
              []
            : [];
          return jsonResponse({ success: true, deposits });
        }

        if (
          path === "/api/admin/deposits/approve" &&
          request.method === "POST"
        ) {
          const { depositId } = body;
          if (!depositId) {
            return jsonResponse(
              { success: false, error: "depositId is required." },
              400
            );
          }

          const deposits = env.DARK_STARK_DB
            ? safeJsonParse((await env.DARK_STARK_DB.get("deposits")) || "[]") ||
              []
            : [];
          const target = deposits.find((d) => d.id === depositId);

          if (!target) {
            return jsonResponse(
              { success: false, error: "Deposit not found." },
              404
            );
          }

          if (target.status === "Approved") {
            return jsonResponse({
              success: true,
              message: "Already approved.",
              deposit: target,
            });
          }

          target.status = "Approved";
          target.approvedAt = new Date().toISOString();

          if (env.DARK_STARK_DB) {
            await env.DARK_STARK_DB.put("deposits", JSON.stringify(deposits));
            const balKey = `balance_${target.userId}`;
            const currentBal = parseFloat(
              (await env.DARK_STARK_DB.get(balKey)) || "0"
            );
            const newBal = currentBal + parseFloat(target.amount || 0);
            await env.DARK_STARK_DB.put(balKey, newBal.toFixed(4));
          }

          return jsonResponse({ success: true, deposit: target });
        }
      }

      return jsonResponse({ success: false, error: "Endpoint not found" }, 404);
    } catch (err) {
      return jsonResponse({ success: false, error: err.message }, 502);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      fetchAndSyncServices(env).catch((err) => {
        console.error("Scheduled sync error:", err.message);
      })
    );
  },
};
            
