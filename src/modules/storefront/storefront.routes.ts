import { Router } from 'express';
import { methodNotAllowed } from '../../middlewares/methodNotAllowed.middleware.js';
import * as controller from './storefront.controller.js';

const router = Router();
router.route('/:slug').get(controller.storefront).all(methodNotAllowed);
router.route('/assets/:assetId').get(controller.asset).all(methodNotAllowed);
router.route('/:slug/render').get(controller.render).all(methodNotAllowed);
router.route('/:slug/products').get(controller.products).all(methodNotAllowed);
router.route('/:slug/products/:productSlug').get(controller.product).all(methodNotAllowed);
router.route('/:slug/cart').get(controller.getCart).post(controller.createCart).all(methodNotAllowed);
router.route('/:slug/cart/items').post(controller.addCartItem).all(methodNotAllowed);
router.route('/:slug/checkout').post(controller.checkout).all(methodNotAllowed);

export default router;
