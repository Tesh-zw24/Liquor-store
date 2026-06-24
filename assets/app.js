let currentUser = null;
let currentProfile = null;
let products = [];
let sales = [];
let movements = [];
let settings = { monthly_rent: 0 };
let pastelSyncJobs = [];
let pastelSyncAvailable = true;
const PASTEL_SYNC_SOURCE = "millet-pos";

function money(value) {
  return "$" + Number(value || 0).toFixed(2);
}

function showMessage(id, text, type = "success") {
  const el = document.getElementById(id);
  if (!el) return;
  el.innerHTML = `<div class="${type}">${text}</div>`;
  setTimeout(() => el.innerHTML = "", 5000);
}

function isSupervisor() {
  return currentProfile && currentProfile.role === "supervisor";
}

function openPanel(panelId) {
  if (panelId === "pastelPanel") {
    setDefaultPastelDates();
    updatePastelPreview();
  }

  document.querySelectorAll(".panel").forEach(panel => {
    panel.classList.remove("active-panel");
  });

  const selected = document.getElementById(panelId);
  if (selected) selected.classList.add("active-panel");

  document.querySelectorAll(".nav-btn").forEach(btn => {
    btn.classList.remove("active");
  });

  const clicked = Array.from(document.querySelectorAll(".nav-btn"))
    .find(btn => btn.getAttribute("onclick") && btn.getAttribute("onclick").includes(panelId));

  if (clicked) clicked.classList.add("active");
}

async function login() {
  const email = document.getElementById("email").value.trim();
  const password = document.getElementById("password").value;

  const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });

  if (error) {
    showMessage("loginMessage", error.message, "error");
    return;
  }

  currentUser = data.user;
  await loadProfile();
  await loadAll();
  render();
  updatePastelPreview();
  openPanel("dashboardPanel");
}

async function logout() {
  await supabaseClient.auth.signOut();
  currentUser = null;
  currentProfile = null;
  document.getElementById("loginScreen").classList.remove("hidden");
  document.getElementById("app").classList.add("hidden");
}

async function loadProfile() {
  const { data, error } = await supabaseClient
    .from("profiles")
    .select("*")
    .eq("id", currentUser.id)
    .single();

  if (error) {
    alert("Profile not found. Add this user to the profiles table.");
    await logout();
    return;
  }

  currentProfile = data;
}

async function loadAll() {
  await Promise.all([
    loadProducts(),
    loadSales(),
    loadMovements(),
    loadSettings(),
    loadPastelSyncJobs()
  ]);
}

async function loadProducts() {
  const { data, error } = await supabaseClient
    .from("products")
    .select("*")
    .order("name", { ascending: true });

  if (!error) products = data || [];
}

async function loadSales() {
  const { data, error } = await supabaseClient
    .from("sales")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(100);

  if (!error) sales = data || [];
}

async function loadMovements() {
  const { data, error } = await supabaseClient
    .from("stock_movements")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(100);

  if (!error) movements = data || [];
}

async function loadSettings() {
  const { data, error } = await supabaseClient
    .from("settings")
    .select("*")
    .eq("setting_key", "monthly_rent")
    .single();

  if (!error && data) settings.monthly_rent = Number(data.setting_value || 0);
}

async function loadPastelSyncJobs() {
  if (!pastelSyncAvailable) return;

  const { data, error } = await supabaseClient
    .from("pastel_sync_queue")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(100);

  if (error) {
    pastelSyncAvailable = false;
    pastelSyncJobs = [];
    console.warn("Pastel sync queue is not installed yet:", error.message);
    return;
  }

  pastelSyncJobs = data || [];
}

async function recordSale() {
  const productId = document.getElementById("saleProduct").value;
  const quantity = Number(document.getElementById("saleQuantity").value);

  if (!productId || quantity <= 0) {
    showMessage("saleMessage", "Select product and enter valid quantity.", "error");
    return;
  }

  const { error } = await supabaseClient.rpc("record_sale_rpc", {
    p_product_id: productId,
    p_quantity: quantity
  });

  if (error) {
    showMessage("saleMessage", error.message, "error");
    return;
  }

  document.getElementById("saleQuantity").value = "";
  await loadAll();

  const latestSale = sales[0];
  if (latestSale) {
    await enqueuePastelSync("sale_invoice", "sales", latestSale.id || `${latestSale.created_at}-${latestSale.product_id}`, buildPastelSalePayload(latestSale));
    await loadPastelSyncJobs();
  }

  showMessage("saleMessage", "Sale recorded successfully and queued for Pastel sync.");
  render();
}

async function receiveStock() {
  if (!isSupervisor()) return;

  const name = document.getElementById("productName").value.trim();
  const cost = Number(document.getElementById("costPrice").value);
  const selling = Number(document.getElementById("sellingPrice").value);
  const quantity = Number(document.getElementById("quantity").value);
  const alertLevel = Number(document.getElementById("alertLevel").value);

  const { error } = await supabaseClient.rpc("receive_stock_rpc", {
    p_name: name,
    p_cost_price: cost,
    p_selling_price: selling,
    p_quantity: quantity,
    p_alert_level: alertLevel
  });

  if (error) {
    showMessage("stockMessage", error.message, "error");
    return;
  }

  document.getElementById("productName").value = "";
  document.getElementById("costPrice").value = "";
  document.getElementById("sellingPrice").value = "";
  document.getElementById("quantity").value = "";
  document.getElementById("alertLevel").value = "5";

  await loadAll();

  const latestMovement = movements[0];
  if (latestMovement) {
    await enqueuePastelSync("stock_movement", "stock_movements", latestMovement.id || `${latestMovement.created_at}-${latestMovement.product_id}`, buildPastelMovementPayload(latestMovement));
    await loadPastelSyncJobs();
  }

  showMessage("stockMessage", "Stock received successfully and queued for Pastel sync.");
  render();
}

async function deductStock() {
  if (!isSupervisor()) return;

  const productId = document.getElementById("deductProduct").value;
  const quantity = Number(document.getElementById("deductQuantity").value);
  const reason = document.getElementById("deductReason").value.trim();

  const { error } = await supabaseClient.rpc("deduct_stock_rpc", {
    p_product_id: productId,
    p_quantity: quantity,
    p_reason: reason
  });

  if (error) {
    alert(error.message);
    return;
  }

  document.getElementById("deductQuantity").value = "";
  document.getElementById("deductReason").value = "";
  await loadAll();

  const latestMovement = movements[0];
  if (latestMovement) {
    await enqueuePastelSync("stock_movement", "stock_movements", latestMovement.id || `${latestMovement.created_at}-${latestMovement.product_id}`, buildPastelMovementPayload(latestMovement));
    await loadPastelSyncJobs();
  }

  render();
}

async function stockTake() {
  if (!isSupervisor()) return;

  const productId = document.getElementById("stockTakeProduct").value;
  const actualQuantity = Number(document.getElementById("stockTakeQuantity").value);

  const { error } = await supabaseClient.rpc("stock_take_rpc", {
    p_product_id: productId,
    p_actual_quantity: actualQuantity
  });

  if (error) {
    alert(error.message);
    return;
  }

  document.getElementById("stockTakeQuantity").value = "";
  await loadAll();

  const latestMovement = movements[0];
  if (latestMovement) {
    await enqueuePastelSync("stock_movement", "stock_movements", latestMovement.id || `${latestMovement.created_at}-${latestMovement.product_id}`, buildPastelMovementPayload(latestMovement));
    await loadPastelSyncJobs();
  }

  render();
}

async function saveSettings() {
  if (!isSupervisor()) return;

  const monthlyRent = Number(document.getElementById("monthlyRent").value || 0);

  const { error } = await supabaseClient
    .from("settings")
    .update({ setting_value: monthlyRent, updated_at: new Date().toISOString() })
    .eq("setting_key", "monthly_rent");

  if (error) {
    alert(error.message);
    return;
  }

  settings.monthly_rent = monthlyRent;
  alert("Settings saved.");
  render();
}

async function changePassword() {
  const oldPassword = document.getElementById("oldPassword").value;
  const newPassword = document.getElementById("newPassword").value;
  const confirmNewPassword = document.getElementById("confirmNewPassword").value;

  if (!oldPassword || !newPassword || !confirmNewPassword) {
    showMessage("passwordMessage", "Fill in all password fields.", "error");
    return;
  }

  if (newPassword.length < 6) {
    showMessage("passwordMessage", "New password must be at least 6 characters.", "error");
    return;
  }

  if (newPassword !== confirmNewPassword) {
    showMessage("passwordMessage", "New passwords do not match.", "error");
    return;
  }

  const { error: verifyError } = await supabaseClient.auth.signInWithPassword({
    email: currentUser.email,
    password: oldPassword
  });

  if (verifyError) {
    showMessage("passwordMessage", "Old password is incorrect.", "error");
    return;
  }

  const { error } = await supabaseClient.auth.updateUser({
    password: newPassword
  });

  if (error) {
    showMessage("passwordMessage", error.message, "error");
    return;
  }

  document.getElementById("oldPassword").value = "";
  document.getElementById("newPassword").value = "";
  document.getElementById("confirmNewPassword").value = "";

  showMessage("passwordMessage", "Password changed successfully.");
}

function getPeriodSales(period) {
  const now = new Date();

  return sales.filter(s => {
    const d = new Date(s.created_at);

    if (period === "daily") return d.toDateString() === now.toDateString();

    if (period === "weekly") {
      const sevenDaysAgo = new Date();
      sevenDaysAgo.setDate(now.getDate() - 7);
      return d >= sevenDaysAgo && d <= now;
    }

    if (period === "monthly") {
      return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
    }

    return false;
  });
}

function calculateReport(period) {
  const periodSales = getPeriodSales(period);
  const revenue = periodSales.reduce((sum, s) => sum + Number(s.revenue), 0);
  const productCost = periodSales.reduce((sum, s) => sum + Number(s.product_cost), 0);
  const grossProfit = periodSales.reduce((sum, s) => sum + Number(s.gross_profit), 0);

  const monthlyRent = Number(settings.monthly_rent || 0);
  const dailyRent = monthlyRent / 30;
  const rent = period === "daily" ? dailyRent : period === "weekly" ? dailyRent * 7 : monthlyRent;
  const netProfit = grossProfit - rent;

  const productTotals = {};
  periodSales.forEach(s => {
    productTotals[s.product_name] = (productTotals[s.product_name] || 0) + Number(s.quantity);
  });

  let topProduct = "No sales yet";
  let highestQty = 0;

  Object.entries(productTotals).forEach(([name, qty]) => {
    if (qty > highestQty) {
      highestQty = qty;
      topProduct = `${name} (${qty} sold)`;
    }
  });

  const averageProfitPerDay =
    period === "daily" ? netProfit :
    period === "weekly" ? netProfit / 7 :
    netProfit / 30;

  return { revenue, productCost, grossProfit, rent, netProfit, averageProfitPerDay, topProduct, numberOfSales: periodSales.length };
}

function showReport(period) {
  const report = calculateReport(period);

  document.getElementById("report").innerHTML = `
    <h3>${period.charAt(0).toUpperCase() + period.slice(1)} Report</h3>
    <div class="metrics">
      <div class="metric">Sales Revenue<strong>${money(report.revenue)}</strong></div>
      <div class="metric">Product Cost<strong>${money(report.productCost)}</strong></div>
      <div class="metric">Gross Profit<strong>${money(report.grossProfit)}</strong></div>
      <div class="metric">Rent Deducted<strong>${money(report.rent)}</strong></div>
      <div class="metric">Net Profit<strong>${money(report.netProfit)}</strong></div>
      <div class="metric">Average Profit / Day<strong>${money(report.averageProfitPerDay)}</strong></div>
      <div class="metric">Most Sought Product<strong>${report.topProduct}</strong></div>
      <div class="metric">Number of Sales<strong>${report.numberOfSales}</strong></div>
    </div>
  `;
}

function fillDropdowns() {
  const ids = ["saleProduct", "deductProduct", "stockTakeProduct"];

  ids.forEach(id => {
    const select = document.getElementById(id);
    if (!select) return;
    select.innerHTML = "";

    products.forEach(p => {
      select.innerHTML += `<option value="${p.id}">${p.name} — ${p.quantity} left — ${money(p.selling_price)}</option>`;
    });
  });
}

function render() {
  if (!currentUser || !currentProfile) return;

  document.getElementById("loginScreen").classList.add("hidden");
  document.getElementById("app").classList.remove("hidden");

  document.getElementById("userInfo").textContent = `${currentProfile.full_name} — ${currentProfile.role}`;

  document.querySelectorAll(".supervisor-only").forEach(el => {
    el.classList.toggle("hidden", !isSupervisor());
  });

  fillDropdowns();

  document.getElementById("productCount").textContent = products.length;
  document.getElementById("monthlyRent").value = settings.monthly_rent || 0;

  const today = calculateReport("daily");
  document.getElementById("todaySales").textContent = money(today.revenue);
  document.getElementById("todayProfit").textContent = money(today.netProfit);
  document.getElementById("topProduct").textContent = today.topProduct;

  const alerts = document.getElementById("alerts");
  alerts.innerHTML = "";

  products.forEach(p => {
    if (Number(p.quantity) <= Number(p.alert_level)) {
      alerts.innerHTML += `<div class="alert">${p.name} has only ${p.quantity} left. Restock soon.</div>`;
    }
  });

  if (!alerts.innerHTML) {
    alerts.innerHTML = `<div class="good">All products have enough stock.</div>`;
  }

  const stockTable = document.getElementById("stockTable");
  stockTable.innerHTML = "";

  products.forEach(p => {
    stockTable.innerHTML += `
      <tr>
        <td>${p.name}</td>
        <td>${money(p.cost_price)}</td>
        <td>${money(p.selling_price)}</td>
        <td>${p.quantity}</td>
        <td>${p.alert_level}</td>
      </tr>
    `;
  });

  const salesTable = document.getElementById("salesTable");
  salesTable.innerHTML = "";

  sales.slice(0, 50).forEach(s => {
    salesTable.innerHTML += `
      <tr>
        <td>${new Date(s.created_at).toLocaleString()}</td>
        <td>${s.product_name}</td>
        <td>${s.quantity}</td>
        <td>${money(s.revenue)}</td>
        <td>${money(s.gross_profit)}</td>
      </tr>
    `;
  });

  const movementTable = document.getElementById("movementTable");
  movementTable.innerHTML = "";

  movements.slice(0, 50).forEach(m => {
    movementTable.innerHTML += `
      <tr>
        <td>${new Date(m.created_at).toLocaleString()}</td>
        <td>${m.movement_type}</td>
        <td>${m.product_name}</td>
        <td>${m.quantity_change}</td>
        <td>${m.reason || ""}</td>
      </tr>
    `;
  });

  updatePastelPreview();
  openPanel("dashboardPanel");
}


/* =========================
   Sage Pastel CSV Integration
   =========================
   This integration is designed for small shops that use Millet POS for daily
   selling and Sage Pastel / Sage 50cloud Pastel for accounting.

   It does not write directly into the Pastel database. Instead it generates
   clean CSV files that can be imported into Pastel and mapped to your company's
   import layout. This is safer for small businesses and avoids corrupting a
   Pastel company file.
*/

function buildPastelSalePayload(sale) {
  const cfg = getPastelSettings();
  const qty = Number(sale.quantity || 0);
  const revenue = Number(sale.revenue || 0);
  const unitPrice = qty ? revenue / qty : 0;

  return {
    type: "sale_invoice",
    source: PASTEL_SYNC_SOURCE,
    documentNo: pastelDocumentNumber(sale, 0),
    documentDate: pastelDate(sale.created_at),
    customerCode: cfg.customerCode || "CASH001",
    customerName: "Cash Customer",
    itemCode: sale.product_id || sale.product_name,
    itemDescription: sale.product_name,
    quantity: qty,
    unitPriceExcl: Number(unitPrice.toFixed(2)),
    taxCode: cfg.taxCode || "0",
    taxAmount: 0,
    lineTotalIncl: Number(revenue.toFixed(2)),
    salesAccount: cfg.salesAccount || "4000/000",
    reference: "Millet POS real-time sale",
    raw: sale
  };
}

function buildPastelMovementPayload(movement) {
  return {
    type: "stock_movement",
    source: PASTEL_SYNC_SOURCE,
    movementDate: pastelDate(movement.created_at),
    movementType: movement.movement_type,
    itemCode: movement.product_id || movement.product_name,
    itemDescription: movement.product_name,
    quantityChange: Number(movement.quantity_change || 0),
    reason: movement.reason || "Millet POS stock movement",
    reference: "Millet POS real-time stock",
    raw: movement
  };
}

async function enqueuePastelSync(jobType, sourceTable, sourceId, payload) {
  if (!pastelSyncAvailable || !sourceId) return;

  const { error } = await supabaseClient
    .from("pastel_sync_queue")
    .upsert({
      job_type: jobType,
      source_table: sourceTable,
      source_id: String(sourceId),
      payload,
      status: "pending",
      attempts: 0,
      created_by: currentUser?.id || null,
      updated_at: new Date().toISOString()
    }, { onConflict: "source_table,source_id,job_type" });

  if (error) {
    pastelSyncAvailable = false;
    console.warn("Pastel sync queue failed:", error.message);
  }
}

async function retryPastelJob(jobId) {
  if (!jobId) return;

  const { error } = await supabaseClient
    .from("pastel_sync_queue")
    .update({ status: "pending", error_message: null, updated_at: new Date().toISOString() })
    .eq("id", jobId);

  if (error) {
    showMessage("pastelSyncMessage", error.message, "error");
    return;
  }

  await loadPastelSyncJobs();
  renderPastelSyncStatus();
  showMessage("pastelSyncMessage", "Job placed back in the Pastel sync queue.");
}

async function refreshPastelSyncStatus() {
  pastelSyncAvailable = true;
  await loadPastelSyncJobs();
  renderPastelSyncStatus();
  showMessage("pastelSyncMessage", "Pastel sync status refreshed.");
}

function syncStatusBadge(status) {
  const safe = String(status || "pending").toLowerCase();
  return `<span class="sync-badge sync-${safe}">${safe}</span>`;
}

function renderPastelSyncStatus() {
  const table = document.getElementById("pastelSyncTable");
  if (!table) return;

  const pending = pastelSyncJobs.filter(j => j.status === "pending").length;
  const synced = pastelSyncJobs.filter(j => j.status === "synced").length;
  const failed = pastelSyncJobs.filter(j => j.status === "failed").length;

  document.getElementById("pastelPendingCount").textContent = pending;
  document.getElementById("pastelSyncedCount").textContent = synced;
  document.getElementById("pastelFailedCount").textContent = failed;
  document.getElementById("pastelQueueAvailable").textContent = pastelSyncAvailable ? "Installed" : "Not installed";

  if (!pastelSyncAvailable) {
    table.innerHTML = `<tr><td colspan="6">Pastel sync queue table is not installed yet. Run <strong>supabase-pastel-sync.sql</strong> in Supabase SQL Editor.</td></tr>`;
    return;
  }

  table.innerHTML = "";
  pastelSyncJobs.slice(0, 30).forEach(job => {
    const payload = job.payload || {};
    table.innerHTML += `
      <tr>
        <td>${new Date(job.created_at).toLocaleString()}</td>
        <td>${job.job_type}</td>
        <td>${payload.documentNo || payload.itemDescription || job.source_id}</td>
        <td>${syncStatusBadge(job.status)}</td>
        <td>${job.attempts || 0}</td>
        <td>${job.status === "failed" ? `<button onclick="retryPastelJob('${job.id}')">Retry</button>` : (job.error_message || "")}</td>
      </tr>
    `;
  });

  if (!table.innerHTML) {
    table.innerHTML = `<tr><td colspan="6">No Pastel sync jobs yet. New sales and stock movements will appear here automatically.</td></tr>`;
  }
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

function ymd(date) {
  const d = new Date(date);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function pastelDate(date) {
  const d = new Date(date);
  return `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${d.getFullYear()}`;
}

function cleanCsvValue(value) {
  const text = String(value ?? "").replace(/\r?\n|\r/g, " ");
  if (/[",\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

function toCsv(rows) {
  return rows.map(row => row.map(cleanCsvValue).join(",")).join("\n");
}

function downloadCsv(filename, rows) {
  const csv = toCsv(rows);
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

function getPastelSettings() {
  return {
    fromDate: document.getElementById("pastelFromDate")?.value,
    toDate: document.getElementById("pastelToDate")?.value,
    customerCode: document.getElementById("pastelCustomerCode")?.value.trim() || "CASH001",
    salesAccount: document.getElementById("pastelSalesAccount")?.value.trim() || "4000/000",
    taxCode: document.getElementById("pastelTaxCode")?.value.trim() || "0",
    docPrefix: document.getElementById("pastelDocPrefix")?.value.trim() || "MIL"
  };
}

function setDefaultPastelDates() {
  const from = document.getElementById("pastelFromDate");
  const to = document.getElementById("pastelToDate");
  if (!from || !to) return;

  const today = ymd(new Date());
  if (!from.value) from.value = today;
  if (!to.value) to.value = today;
}

function salesInPastelPeriod() {
  const cfg = getPastelSettings();
  if (!cfg.fromDate || !cfg.toDate) return [];

  const from = new Date(cfg.fromDate + "T00:00:00");
  const to = new Date(cfg.toDate + "T23:59:59");

  return sales.filter(s => {
    const d = new Date(s.created_at);
    return d >= from && d <= to;
  }).sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
}

function movementsInPastelPeriod() {
  const cfg = getPastelSettings();
  if (!cfg.fromDate || !cfg.toDate) return [];

  const from = new Date(cfg.fromDate + "T00:00:00");
  const to = new Date(cfg.toDate + "T23:59:59");

  return movements.filter(m => {
    const d = new Date(m.created_at);
    return d >= from && d <= to;
  }).sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
}

function pastelDocumentNumber(sale, index) {
  const cfg = getPastelSettings();
  const d = new Date(sale.created_at);
  const datePart = `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`;
  return `${cfg.docPrefix}-${datePart}-${String(index + 1).padStart(4, "0")}`;
}

function buildPastelSalesInvoiceRows() {
  const cfg = getPastelSettings();
  const periodSales = salesInPastelPeriod();

  const rows = [[
    "DocumentNo",
    "DocumentDate",
    "CustomerCode",
    "CustomerName",
    "ItemCode",
    "ItemDescription",
    "Quantity",
    "UnitPriceExcl",
    "TaxCode",
    "TaxAmount",
    "LineTotalIncl",
    "SalesAccount",
    "Reference"
  ]];

  periodSales.forEach((s, index) => {
    const qty = Number(s.quantity || 0);
    const revenue = Number(s.revenue || 0);
    const unitPrice = qty ? revenue / qty : 0;

    rows.push([
      pastelDocumentNumber(s, index),
      pastelDate(s.created_at),
      cfg.customerCode,
      "Cash Customer",
      s.product_id || s.product_name,
      s.product_name,
      qty,
      unitPrice.toFixed(2),
      cfg.taxCode,
      "0.00",
      revenue.toFixed(2),
      cfg.salesAccount,
      "Millet POS sale"
    ]);
  });

  return rows;
}

function buildPastelDailyJournalRows() {
  const cfg = getPastelSettings();
  const periodSales = salesInPastelPeriod();
  const revenue = periodSales.reduce((sum, s) => sum + Number(s.revenue || 0), 0);
  const productCost = periodSales.reduce((sum, s) => sum + Number(s.product_cost || 0), 0);
  const grossProfit = periodSales.reduce((sum, s) => sum + Number(s.gross_profit || 0), 0);
  const reference = `${cfg.docPrefix}-${cfg.fromDate}-TO-${cfg.toDate}`;

  return [[
    "JournalDate",
    "Reference",
    "Account",
    "Description",
    "Debit",
    "Credit",
    "TaxCode"
  ], [
    pastelDate(cfg.toDate),
    reference,
    "1000/000",
    "Cash / Bank control - Millet POS sales",
    revenue.toFixed(2),
    "0.00",
    cfg.taxCode
  ], [
    pastelDate(cfg.toDate),
    reference,
    cfg.salesAccount,
    "Sales revenue - Millet POS",
    "0.00",
    revenue.toFixed(2),
    cfg.taxCode
  ], [
    pastelDate(cfg.toDate),
    reference,
    "5000/000",
    "Cost of sales - Millet POS",
    productCost.toFixed(2),
    "0.00",
    "0"
  ], [
    pastelDate(cfg.toDate),
    reference,
    "1300/000",
    "Inventory control - Millet POS",
    "0.00",
    productCost.toFixed(2),
    "0"
  ], [
    pastelDate(cfg.toDate),
    reference,
    "9999/000",
    `Gross profit memo: ${grossProfit.toFixed(2)}`,
    "0.00",
    "0.00",
    "0"
  ]];
}

function buildPastelProductsRows() {
  const rows = [[
    "ItemCode",
    "Description",
    "CostPrice",
    "SellingPrice",
    "QuantityOnHand",
    "ReorderLevel",
    "SalesAccount",
    "InventoryAccount"
  ]];

  products.forEach(p => {
    rows.push([
      p.id || p.name,
      p.name,
      Number(p.cost_price || 0).toFixed(2),
      Number(p.selling_price || 0).toFixed(2),
      Number(p.quantity || 0),
      Number(p.alert_level || 0),
      getPastelSettings().salesAccount,
      "1300/000"
    ]);
  });

  return rows;
}

function buildPastelStockMovementRows() {
  const rows = [[
    "MovementDate",
    "MovementType",
    "ItemCode",
    "ItemDescription",
    "QuantityChange",
    "Reason",
    "Reference"
  ]];

  movementsInPastelPeriod().forEach(m => {
    rows.push([
      pastelDate(m.created_at),
      m.movement_type,
      m.product_id || m.product_name,
      m.product_name,
      Number(m.quantity_change || 0),
      m.reason || "",
      "Millet POS stock movement"
    ]);
  });

  return rows;
}

function validatePastelExport() {
  setDefaultPastelDates();
  const cfg = getPastelSettings();
  if (!cfg.fromDate || !cfg.toDate) {
    showMessage("pastelMessage", "Select export dates first.", "error");
    return false;
  }
  if (new Date(cfg.fromDate) > new Date(cfg.toDate)) {
    showMessage("pastelMessage", "From Date cannot be after To Date.", "error");
    return false;
  }
  return true;
}

function pastelFileName(type) {
  const cfg = getPastelSettings();
  return `millet-pastel-${type}-${cfg.fromDate}-to-${cfg.toDate}.csv`;
}

function exportPastelSalesInvoices() {
  if (!validatePastelExport()) return;
  downloadCsv(pastelFileName("sales-invoices"), buildPastelSalesInvoiceRows());
  showMessage("pastelMessage", "Sales invoice CSV exported for Sage Pastel.");
}

function exportPastelDailyJournal() {
  if (!validatePastelExport()) return;
  downloadCsv(pastelFileName("daily-journal"), buildPastelDailyJournalRows());
  showMessage("pastelMessage", "Daily journal CSV exported for Sage Pastel.");
}

function exportPastelProducts() {
  if (!validatePastelExport()) return;
  downloadCsv(pastelFileName("inventory-items"), buildPastelProductsRows());
  showMessage("pastelMessage", "Inventory items CSV exported for Sage Pastel.");
}

function exportPastelStockMovements() {
  if (!validatePastelExport()) return;
  downloadCsv(pastelFileName("stock-movements"), buildPastelStockMovementRows());
  showMessage("pastelMessage", "Stock movement CSV exported for Sage Pastel.");
}

function exportPastelBundle() {
  if (!validatePastelExport()) return;
  exportPastelSalesInvoices();
  setTimeout(exportPastelDailyJournal, 250);
  setTimeout(exportPastelProducts, 500);
  setTimeout(exportPastelStockMovements, 750);
}

function updatePastelPreview() {
  const countEl = document.getElementById("pastelSalesCount");
  if (!countEl) return;

  setDefaultPastelDates();
  const periodSales = salesInPastelPeriod();
  const periodMovements = movementsInPastelPeriod();
  const revenue = periodSales.reduce((sum, s) => sum + Number(s.revenue || 0), 0);

  document.getElementById("pastelSalesCount").textContent = periodSales.length;
  document.getElementById("pastelRevenue").textContent = money(revenue);
  document.getElementById("pastelProductCount").textContent = products.length;
  document.getElementById("pastelMovementCount").textContent = periodMovements.length;

  const table = document.getElementById("pastelPreviewTable");
  if (!table) return;

  table.innerHTML = "";
  periodSales.slice(0, 50).forEach((s, index) => {
    table.innerHTML += `
      <tr>
        <td>${new Date(s.created_at).toLocaleString()}</td>
        <td>${pastelDocumentNumber(s, index)}</td>
        <td>${getPastelSettings().customerCode}</td>
        <td>${s.product_name}</td>
        <td>${s.quantity}</td>
        <td>${money(s.revenue)}</td>
      </tr>
    `;
  });

  if (!table.innerHTML) {
    table.innerHTML = `<tr><td colspan="6">No sales found for the selected period.</td></tr>`;
  }
}

document.addEventListener("change", event => {
  if (event.target && event.target.id && event.target.id.startsWith("pastel")) {
    updatePastelPreview();
  }
});

document.addEventListener("input", event => {
  if (event.target && event.target.id && event.target.id.startsWith("pastel")) {
    updatePastelPreview();
  }
});


async function init() {
  const { data } = await supabaseClient.auth.getSession();

  if (data.session) {
    currentUser = data.session.user;
    await loadProfile();
    await loadAll();
    render();
  }
}

init();
