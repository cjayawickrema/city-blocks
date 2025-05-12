import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

function csvToNestedStructure(csvString) {
    const lines = csvString.trim().split('\n');
    const header = lines.shift();

    const root = {
        name: "root",
        fullPath: "",
        childDirectories: [],
        childFiles: [],
        loc: 0,
        count: 0
    };

    lines.forEach(line => {
        const values = line.split(',');
        if (values.length < 3) {
            return;
        }

        const countStr = values[0];
        const path = values[1];
        const locStr = values[2];

        if (!path || path.trim() === "") {
            return;
        }

        const count = parseInt(countStr, 10);
        const loc = parseInt(locStr, 10);

        if (isNaN(count) || isNaN(loc)) {
            return;
        }

        const parts = path.split('/');
        const fileName = parts.pop();

        let currentDirectory = root;
        let currentPathSegments = [];

        parts.forEach(partName => {
            currentPathSegments.push(partName);
            let directory = currentDirectory.childDirectories.find(dir => dir.name === partName);
            if (!directory) {
                directory = {
                    name: partName,
                    fullPath: currentPathSegments.join('/'),
                    childDirectories: [],
                    childFiles: [],
                    loc: 0,
                    count: 0
                };
                currentDirectory.childDirectories.push(directory);
            }
            currentDirectory = directory;
        });

        if (fileName) {
            currentDirectory.childFiles.push({
                name: fileName,
                fullPath: path,
                loc: loc,
                count: count
            });
        }
    });

    function calculateDirectoryStats(directoryNode) {
        let totalLoc = 0;
        let totalCount = 0;

        directoryNode.childFiles.forEach(file => {
            totalLoc += file.loc;
            totalCount += file.count;
        });

        directoryNode.childDirectories.forEach(childDir => {
            calculateDirectoryStats(childDir);
            totalLoc += childDir.loc;
            totalCount += childDir.count;
        });

        directoryNode.loc = totalLoc;
        directoryNode.count = totalCount;
    }

    calculateDirectoryStats(root);
    return root;
}

const FOUNDATION_HEIGHT = 5;
const PADDING = 20; 
const ITEM_SPACING = 10; 
// HEIGHT_FACTOR is not used if building dimensions are based on 'loc' for cubes.
const HEIGHT_FACTOR = 30; 
const MIN_VISIBLE_BUILDING_SIDE = 2.5; // Min side length for a building cube if loc is 0 or too small
const MIN_LAYOUT_DIMENSION = 5; 

const BASE_FOUNDATION_COLOR = new THREE.Color(0xdddddd); 
const FOUNDATION_DARKEN_PER_LEVEL = 0.05; 

const GROUND_MATERIAL = new THREE.MeshLambertMaterial({ color: 0x50c878 }); 

let scene, camera, renderer, controls;
let raycaster, mouse, tooltipElement, intersectedObject = null;
const pickableObjects = []; 
let loadingMessageElement;

function collectAllFiles(node, fileList) {
    if (!node) return;
    if (node.childFiles && Array.isArray(node.childFiles)) {
        node.childFiles.forEach(file => {
            fileList.push(file);
        });
    }
    if (node.childDirectories && Array.isArray(node.childDirectories)) {
        node.childDirectories.forEach(dir => {
            collectAllFiles(dir, fileList);
        });
    }
}

function preprocessFileData(rootNode) {
    const allFiles = [];
    collectAllFiles(rootNode, allFiles);

    let largestCountValue = 0;
    if (allFiles.length > 0) {
        largestCountValue = allFiles.reduce((max, file) => Math.max(max, file.count || 0), 0);
    }
    const effectiveLargestCount = largestCountValue === 0 ? 1 : largestCountValue;

    allFiles.forEach(file => {
        file.heat = (file.count || 0) / effectiveLargestCount;
        // 'loc' from CSV is used directly. Ensure it's a number.
        file.loc = file.loc || 0; 
    });
}

function getHeatColor(heatInput) {
    const heat = (typeof heatInput === 'number' && !isNaN(heatInput)) ? heatInput : 0;
    const color = new THREE.Color();
    const yellow = new THREE.Color(0xffff00); // Heat = 0
    const red = new THREE.Color(0xff0000);     // Heat = 1

    if (heat <= 0) return yellow; 
    if (heat >= 1) return red;   

    color.lerpColors(yellow, red, heat);
    
    return color;
}

function calculateLayout(node) {
    if (!node) return { width: 0, depth: 0 };
    const isDirectoryNode = !!(node.childFiles || node.childDirectories);
    node.isDirectory = isDirectoryNode; 

    if (isDirectoryNode) {
        let layoutItems = []; 
        const childrenToProcess = [...(node.childFiles || []), ...(node.childDirectories || [])];

        childrenToProcess.forEach(child => {
            calculateLayout(child); 
            const isChildDir = child.isDirectory;
            let childW, childD;

            if (isChildDir) {
                childW = child.calculatedOuterWidth;
                childD = child.calculatedOuterDepth;
            } else { // It's a File
                child.loc = child.loc || 0; 
                childW = child.loc > 0 ? child.loc : MIN_LAYOUT_DIMENSION;
                childD = child.loc > 0 ? child.loc : MIN_LAYOUT_DIMENSION;
                child.buildingHeight = child.loc > 0 ? child.loc : MIN_VISIBLE_BUILDING_SIDE; // Height is 'loc' for a cube
            }
            layoutItems.push({ node: child, w: childW, d: childD }); 
        });

        layoutItems.sort((a, b) => b.d - a.d || b.w - a.w);

        let currentZ = 0; 
        node.innerWidth = 0;    
        let unplacedItems = [...layoutItems];
        
        let totalAreaOfChildren = 0;
        layoutItems.forEach(item => totalAreaOfChildren += item.w * item.d);
        let targetRowWidth = Math.sqrt(totalAreaOfChildren) * 1.2; 
        if (layoutItems.length > 0) {
             targetRowWidth = Math.max(targetRowWidth, layoutItems.reduce((maxW, item) => Math.max(maxW, item.w), 0));
        }
        targetRowWidth = Math.max(targetRowWidth, MIN_LAYOUT_DIMENSION); 


        while (unplacedItems.length > 0) {
            let itemsInCurrentRow = [];
            let currentRowAccumulatedWidth = 0; 
            let currentRowMaxDepth = 0;   
            let remainingForNextPass = [];

            for (const item of unplacedItems) {
                if (itemsInCurrentRow.length === 0) { 
                    itemsInCurrentRow.push(item);
                    currentRowAccumulatedWidth = item.w;
                    currentRowMaxDepth = item.d;
                } else if (currentRowAccumulatedWidth + ITEM_SPACING + item.w <= targetRowWidth) {
                    itemsInCurrentRow.push(item);
                    currentRowAccumulatedWidth += ITEM_SPACING + item.w;
                    currentRowMaxDepth = Math.max(currentRowMaxDepth, item.d);
                } else {
                    remainingForNextPass.push(item); 
                }
            }
            
            if (itemsInCurrentRow.length === 0 && remainingForNextPass.length > 0) { 
                const nextItem = remainingForNextPass.shift(); 
                itemsInCurrentRow.push(nextItem);
                currentRowAccumulatedWidth = nextItem.w;
                currentRowMaxDepth = nextItem.d;
            }
            
            if (itemsInCurrentRow.length === 0) break; 

            let currentXOffsetInRow = 0;
            itemsInCurrentRow.forEach(item => {
                item.node.prelimX = currentXOffsetInRow + item.w / 2; 
                item.node.prelimZ = currentZ + item.d / 2;      
                currentXOffsetInRow += item.w + ITEM_SPACING;
            });

            node.innerWidth = Math.max(node.innerWidth, currentRowAccumulatedWidth); 
            currentZ += currentRowMaxDepth + ITEM_SPACING;   
            unplacedItems = remainingForNextPass; 
        }

        node.innerDepth = (currentZ > 0) ? currentZ - ITEM_SPACING : 0; 

        childrenToProcess.forEach(childNode => { 
            if (childNode.prelimX !== undefined && childNode.prelimZ !== undefined) {
                childNode.renderOffsetX = childNode.prelimX - node.innerWidth / 2;
                childNode.renderOffsetZ = childNode.prelimZ - node.innerDepth / 2;
            } else { 
                childNode.renderOffsetX = 0 - node.innerWidth / 2; 
                childNode.renderOffsetZ = 0 - node.innerDepth / 2;
            }
        });
        
        node.calculatedOuterWidth = node.innerWidth + 2 * PADDING;
        node.calculatedOuterDepth = node.innerDepth + 2 * PADDING;
        node.foundationHeight = FOUNDATION_HEIGHT;
        return { width: node.calculatedOuterWidth, depth: node.calculatedOuterDepth };

    } else { // It's a File
        node.loc = node.loc || 0; 
        if (node.buildingHeight === undefined) { 
             node.buildingHeight = node.loc > 0 ? node.loc : MIN_VISIBLE_BUILDING_SIDE;
        }
        const w = node.loc > 0 ? node.loc : MIN_LAYOUT_DIMENSION;
        const d = node.loc > 0 ? node.loc : MIN_LAYOUT_DIMENSION;
        return { width: w, depth: d };
    }
}

function createThreeObjects(node, parentThreeGroup, baseCenterPosition, depthLevel) {
    if (!node) return;

    if (node.isDirectory) { 
        const geoWidth = Math.max(node.calculatedOuterWidth, 0.1); 
        const geoHeight = Math.max(node.foundationHeight, 0.1);
        const geoDepth = Math.max(node.calculatedOuterDepth, 0.1);
        
        const foundationGeo = new THREE.BoxGeometry(geoWidth, geoHeight, geoDepth);

        const colorScaleFactor = Math.max(0, 1.0 - (depthLevel * FOUNDATION_DARKEN_PER_LEVEL));
        const foundationColor = new THREE.Color(
            BASE_FOUNDATION_COLOR.r * colorScaleFactor,
            BASE_FOUNDATION_COLOR.g * colorScaleFactor,
            BASE_FOUNDATION_COLOR.b * colorScaleFactor
        );
        const currentFoundationMaterial = new THREE.MeshLambertMaterial({ color: foundationColor });

        const foundationMesh = new THREE.Mesh(foundationGeo, currentFoundationMaterial);
        foundationMesh.position.set(
            baseCenterPosition.x,
            baseCenterPosition.y + node.foundationHeight / 2, 
            baseCenterPosition.z
        );
        foundationMesh.userData = { type: 'Directory', nodeData: node, depthLevel: depthLevel };
        parentThreeGroup.add(foundationMesh);
        pickableObjects.push(foundationMesh); 

        const childrenBaseY = baseCenterPosition.y + node.foundationHeight;
        const childrenOriginX = baseCenterPosition.x; 
        const childrenOriginZ = baseCenterPosition.z;
        
        const childrenToDraw = [...(node.childFiles || []), ...(node.childDirectories || [])];
        childrenToDraw.forEach(childNode => {
            const offsetX = childNode.renderOffsetX === undefined ? (-node.innerWidth/2 - (childNode.w || MIN_LAYOUT_DIMENSION)) : childNode.renderOffsetX; 
            const offsetZ = childNode.renderOffsetZ === undefined ? (-node.innerDepth/2 - (childNode.d || MIN_LAYOUT_DIMENSION)) : childNode.renderOffsetZ; 

            const childCenterPos = new THREE.Vector3(
                childrenOriginX + offsetX,
                childrenBaseY, 
                childrenOriginZ + offsetZ
            );
            createThreeObjects(childNode, parentThreeGroup, childCenterPos, depthLevel + 1);
        });

    } else { // It's a File (Building)
        node.loc = node.loc || 0; 
        const sideLength = node.loc > 0 ? node.loc : MIN_VISIBLE_BUILDING_SIDE;

        const buildingWidth = sideLength;
        const buildingDepth = sideLength;
        const buildingHeight = sideLength; // For a cube, height is same as sideLength (loc)

        const buildingColor = getHeatColor(node.heat); 
        const buildingMaterial = new THREE.MeshLambertMaterial({ color: buildingColor });

        const buildingGeo = new THREE.BoxGeometry(
            Math.max(buildingWidth, 0.1), 
            Math.max(buildingHeight, 0.1),
            Math.max(buildingDepth, 0.1)
        );
        const buildingMesh = new THREE.Mesh(buildingGeo, buildingMaterial);
        buildingMesh.position.set(
            baseCenterPosition.x,
            baseCenterPosition.y + buildingHeight / 2, 
            baseCenterPosition.z
        );
        buildingMesh.userData = { type: 'File', nodeData: node };
        parentThreeGroup.add(buildingMesh);
        pickableObjects.push(buildingMesh); 
    }
}

function onMouseMove(event) {
    if (!mouse || !tooltipElement) return;
    mouse.x = (event.clientX / window.innerWidth) * 2 - 1;
    mouse.y = - (event.clientY / window.innerHeight) * 2 + 1;
    tooltipElement.style.left = (event.clientX + 15) + 'px';
    tooltipElement.style.top = (event.clientY + 15) + 'px';
}

function updateTooltip() {
    if(!raycaster || !mouse || !camera || !tooltipElement) return; 
    raycaster.setFromCamera(mouse, camera); 
    const intersects = raycaster.intersectObjects(pickableObjects, false); 

    if (intersects.length > 0) {
        const firstIntersected = intersects[0].object;
        if (firstIntersected !== intersectedObject) { 
            intersectedObject = firstIntersected;
            if (intersectedObject.userData && intersectedObject.userData.nodeData) {
                const nodeData = intersectedObject.userData.nodeData;
                const type = intersectedObject.userData.type;
                let locText = nodeData.loc !== undefined ? `${nodeData.loc} Lines (Side Length)` : 'N/A Lines'; // Clarified loc usage
                let countText = (nodeData.count || 0) !== undefined ? `${nodeData.count || 0} Commits` : 'N/A Commits';
                let fullPathText = nodeData.fullPath;

                if (type === 'Directory' && !fullPathText && nodeData.name === "root") {
                    fullPathText = "/ (Project Root)";
                } else if (!fullPathText && nodeData.name) {
                    fullPathText = nodeData.name; 
                } else if (!fullPathText && !nodeData.name) {
                    fullPathText = "N/A";
                }
                let tooltipHTML = `
                    <strong>${nodeData.name || 'Unnamed'}</strong>
                    <ul>
                        <li>${fullPathText}</li>
                        <li>${locText}</li> 
                        <li>${countText}</li>
                        ${type === 'File' && nodeData.heat !== undefined ? `<li>Heat: ${nodeData.heat.toFixed(2)}</li>` : ''}
                        ${type === 'Directory' && intersectedObject.userData.depthLevel !== undefined ? `<li>Depth: ${intersectedObject.userData.depthLevel}</li>` : ''}
                    </ul>
                `;
                tooltipElement.style.display = 'block';
                tooltipElement.innerHTML = tooltipHTML;
            } else { 
                tooltipElement.style.display = 'none';
                intersectedObject = null;
            }
        }
    } else { 
        if (intersectedObject !== null) { 
            tooltipElement.style.display = 'none';
            intersectedObject = null;
        }
    }
}

function initScene(currentNestedStructure) {
    preprocessFileData(currentNestedStructure); 
    
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0xabcdef); 

    const aspect = window.innerWidth / window.innerHeight;
    camera = new THREE.PerspectiveCamera(75, aspect, 5, 60000); 

    const canvas = document.getElementById('canvas');
    renderer = new THREE.WebGLRenderer({ 
        antialias: true, 
        canvas: canvas,
        logarithmicDepthBuffer: true 
    });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.shadowMap.enabled = true; 

    controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;
    controls.minDistance = 5; 
    controls.maxDistance = 50000; 
    controls.maxPolarAngle = Math.PI / 2 - 0.01; 

    const ambientLight = new THREE.AmbientLight(0xffffff, 0.8);
    scene.add(ambientLight);
    const directionalLight = new THREE.DirectionalLight(0xffffff, 1.0);
    directionalLight.position.set(150, 250, 200);
    directionalLight.castShadow = true;
    directionalLight.shadow.mapSize.width = 2048; 
    directionalLight.shadow.mapSize.height = 2048;
    directionalLight.shadow.camera.near = 10;
    directionalLight.shadow.camera.far = 1000; 
    directionalLight.shadow.camera.left = -500;
    directionalLight.shadow.camera.right = 500;
    directionalLight.shadow.camera.top = 500;
    directionalLight.shadow.camera.bottom = -500;
    scene.add(directionalLight);

    raycaster = new THREE.Raycaster();
    mouse = new THREE.Vector2(-1000,-1000); 
    tooltipElement = document.getElementById('tooltip');
    loadingMessageElement = document.getElementById('loading-message');
    window.addEventListener('mousemove', onMouseMove, false);
    
    const overallLayout = calculateLayout(currentNestedStructure);
    
    const groundSize = Math.max(overallLayout.width || 100, overallLayout.depth || 100, 200) * 2.0;
    const groundGeo = new THREE.PlaneGeometry(groundSize, groundSize);
    const groundMesh = new THREE.Mesh(groundGeo, GROUND_MATERIAL.clone());
    groundMesh.rotation.x = -Math.PI / 2; 
    groundMesh.position.y = -0.1; 
    groundMesh.receiveShadow = true;
    scene.add(groundMesh);
    
    if (currentNestedStructure.isDirectory) {
         createThreeObjects(currentNestedStructure, scene, new THREE.Vector3(0, 0, 0), 0); 
    } else if (currentNestedStructure.loc !== undefined && currentNestedStructure.count !== undefined) { 
         createThreeObjects(currentNestedStructure, scene, new THREE.Vector3(0,0,0), 0);
    } else {
         const childrenToDraw = [...(currentNestedStructure.childFiles || []), ...(currentNestedStructure.childDirectories || [])];
         childrenToDraw.forEach(childNode => {
             const childCenterPos = new THREE.Vector3(
                 childNode.renderOffsetX || 0,
                 0, 
                 childNode.renderOffsetZ || 0
             );
             createThreeObjects(childNode, scene, childCenterPos, 0); 
         });
    }

    if (overallLayout && overallLayout.width !== undefined && overallLayout.depth !== undefined && overallLayout.width > 0 && overallLayout.depth > 0) {
        camera.position.set(overallLayout.width * 0.75, Math.max(overallLayout.width, overallLayout.depth) * 0.6, overallLayout.depth * 0.75);
        controls.target.set(0, Math.min(overallLayout.width, overallLayout.depth) / 8 , 0); 
    } else { 
        camera.position.set(100, 150, 200);
        controls.target.set(0, 0, 0);
    }
    camera.lookAt(controls.target);
    controls.update();

    window.addEventListener('resize', onWindowResize, false);
    
    if (loadingMessageElement) {
        loadingMessageElement.style.display = 'none'; 
    }
    animate(); 
}

async function loadDataAndInitialize() {
    try {
        const response = await fetch('data.csv'); 
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status} - Could not load data.csv. Make sure it's in the same directory and you are using a web server.`);
        }
        const csvString = await response.text();
        const dynamicallyGeneratedNestedStructure = csvToNestedStructure(csvString);
        
        initScene(dynamicallyGeneratedNestedStructure);

    } catch (error) {
        console.error("Error loading or processing CSV data:", error);
        const canvasElement = document.getElementById('canvas');
        const loadingElem = document.getElementById('loading-message');
        if (loadingElem) loadingElem.style.display = 'none';

        if(canvasElement) { 
            canvasElement.outerHTML = `<div style="padding: 20px; color: red; text-align: center; font-family: Arial, sans-serif;">
                                         <h2>Error Initializing Visualization</h2>
                                         <p>${error.message}</p>
                                         <p>Please check the console for more details and ensure 'data.csv' is correctly formatted and accessible.</p>
                                       </div>`;
        }
    }
}

function onWindowResize() {
    if (!camera || !renderer) return;
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
}

function animate() {
    requestAnimationFrame(animate);
    if (controls) controls.update(); 
    updateTooltip(); 
    if (scene && camera && renderer) renderer.render(scene, camera); 
}

loadDataAndInitialize();
