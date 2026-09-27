# FluidGlass material provenance

The implementation is **Drei's actual `MeshTransmissionMaterialImpl`**, the material used by React Bits FluidGlass. It is not the React Bits SpecularButton shader or a custom glass approximation.

- Upstream repository: https://github.com/pmndrs/drei
- Pinned commit: `66b9bda91eee0ae98837e16c053888c34341421e`
- Original file: https://github.com/pmndrs/drei/blob/66b9bda91eee0ae98837e16c053888c34341421e/src/core/MeshTransmissionMaterial.tsx
- Original SHA-256: `a3c92804e55051e543a11f1c4e836ccc8535a2e80c5049b8034df5f4bc26b286`
- Original source is retained as `MeshTransmissionMaterial.upstream.tsx`.
- License: MIT, copyright 2020 react-spring; full text in `LICENSE`.
- Attribution to shader author @N8Programs is preserved in the original file.

`MeshTransmissionMaterial.js` removes TypeScript declarations and the React/R3F wrapper and exports the implementation class. GLSL template literals are preserved byte for byte. It uses this project's existing Three renderer. `fluid-glass-material.js` applies FluidGlass settings and a separate, explicitly documented alpha-coverage adapter. Upstream itself discards transmitted alpha in its RGB sampling loop; the adapter does not change upstream refraction math.

`FluidGlass.reference.jsx` is the supplied official React Bits source reference, retained to document `MeshTransmissionMaterial` usage and its ior 1.15 / thickness 5 / anisotropy .01 defaults. It is not imported, bundled, or executed. Its demo photos and page scaffolding are not loaded. The original bar GLB is separately downloaded to `public/fluidglass/bar.glb` and used by the native renderer. React Bits licensing is retained at `../../REACT-BITS-LICENSE.md`. Grayscale adaptation sets chromatic aberration to zero.

Three 0.186 still exposes upstream's PhysicalMaterial fields and the deprecated `inverseTransformDirection` alias, so no shader compatibility rewrite is required. Focused tests exercise the actual Three shader hooks; GPU compilation and stereo FBO routing must also be verified by the renderer integration.
