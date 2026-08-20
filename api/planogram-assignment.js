const {
  fetchPlanogramAssignmentPreview,
  postPlanogramAutoAssign,
} = require("../lib/planogram-tasks");

module.exports = async function handler(req, res) {
  try {
    let payload;
    if (req.method === "GET") payload = await fetchPlanogramAssignmentPreview();
    else if (req.method === "POST") payload = await postPlanogramAutoAssign();
    else {
      res.setHeader("Allow", "GET, POST");
      return res.status(405).json({ ok: false, message: "Method not allowed" });
    }

    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json(payload);
  } catch (error) {
    console.error("Planogram assignment failed", { method: req.method, message: error.message });
    return res.status(500).json({
      ok: false,
      message: "Auto assign PIC Planogram gagal diproses",
    });
  }
};
