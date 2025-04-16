import { Router, Request, Response } from "express";
import cookieParser from "cookie-parser";

export const router = Router();

router.post("/debug/request", cookieParser(), async (req: Request, res: Response) => {
  try {
    res.status(200).json({
      message: "Debug request endpoint",
      requestBody: req.body,
      headers: req.headers,
    });
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
}); 