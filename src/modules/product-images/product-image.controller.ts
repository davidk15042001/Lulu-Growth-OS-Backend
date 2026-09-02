import type { NextFunction, Response } from 'express';
import type { WorkspaceRequest } from '../../middlewares/workspace.middleware.js';
import { createdResponse } from '../../utils/response.js';
import * as service from './product-image.service.js';

export async function generate(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const workspaceId = String(req.params.workspaceId ?? '');
    const userId = req.user!.id;
    const file = (req.file as Express.Multer.File | undefined)
      ?? (req.files as Express.Multer.File[] | undefined)?.[0];
    const fallbackText = String((req.body as { text?: unknown } | undefined)?.text ?? '');
    const text = await service.extractTextFromUpload(
      file ? { name: file.originalname, type: file.mimetype, buffer: file.buffer } : undefined,
      fallbackText,
      workspaceId,
      userId,
    );
    const result = await service.generateProductImagesFromText(text, workspaceId, userId);
    return createdResponse(res, 'Product images generated', result);
  } catch (error) {
    next(error);
  }
}

export async function image(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const workspaceId = String(req.params.workspaceId ?? '');
    const imageId = String(req.params.imageId ?? '');
    const buffer = await service.getProductImage(workspaceId, imageId);
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    return res.send(buffer);
  } catch (error) {
    next(error);
  }
}
