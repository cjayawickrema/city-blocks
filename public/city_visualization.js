import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// CSV parsing function (as provided before)
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
        if (values.length < 3) return; 

        const countStr = values[0];
        const path = values[1];
        const locStr = values[2];

        if (!path || path.trim() === "") return; 

        const count = parseInt(countStr, 10);
        const loc = parseInt(locStr, 10);

        if (isNaN(count) || isNaN(loc)) return;


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

        if (fileName) { // Ensure fileName is not empty (e.g. for paths ending in /)
            currentDirectory.childFiles.push({
                name: fileName,
                fullPath: path, 
                loc: loc,
                count: count
            });
        } else {
             // This case might indicate a path that is a directory itself,
             // but our CSV structure implies all lines are files.
             // For now, we assume fileName is always present.
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


// Constants for visualization
const FOUNDATION_HEIGHT = 5;
const PADDING = 20;
const ITEM_SPACING = 10;
const HEIGHT_FACTOR = 30;
const MIN_VISIBLE_BUILDING_HEIGHT = 0.5;
const MIN_LAYOUT_DIMENSION = 5; 
const MIN_RENDER_DIMENSION = 2.5;

const BASE_FOUNDATION_COLOR = new THREE.Color(0xdddddd);
const FOUNDATION_DARKEN_PER_LEVEL = 0.05;

const GROUND_MATERIAL = new THREE.MeshLambertMaterial({ color: 0x50c878 });
const PACKING_ASPECT_RATIO_TARGET = 2.0; // You can tune this

// Global Three.js variables
let scene, camera, renderer, controls;
let raycaster, mouse, tooltipElement, intersectedObject = null;
const pickableObjects = [];

// Helper function to collect all files
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

// Function to preprocess file data for heat calculation
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
    });
}

// Function to get color based on heat
function getHeatColor(heatInput) {
    const heat = (typeof heatInput === 'number' && !isNaN(heatInput)) ? heatInput : 0;
    const color = new THREE.Color();
    const blue = new THREE.Color(0x0000ff);
    const yellow = new THREE.Color(0xffff00);
    const red = new THREE.Color(0xff0000);
    if (heat <= 0) return blue;
    if (heat >= 1) return red;
    if (heat <= 0.5) {
        color.lerpColors(blue, yellow, heat * 2);
    } else {
        color.lerpColors(yellow, red, (heat - 0.5) * 2);
    }
    return color;
}

// Squarified packing layout function
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
            const childW = isChildDir ? child.calculatedOuterWidth : (child.loc > 0 ? child.loc : MIN_LAYOUT_DIMENSION);
            const childD = isChildDir ? child.calculatedOuterDepth : (child.loc > 0 ? child.loc : MIN_LAYOUT_DIMENSION);
            if (!isChildDir) { 
                 child.buildingHeight = Math.max((child.count || 0) * HEIGHT_FACTOR, MIN_VISIBLE_BUILDING_HEIGHT);
            }
            layoutItems.push({ node: child, w: childW, d: childD, area: childW * childD });
        });

        layoutItems.sort((a, b) => b.area - a.area || Math.max(b.w, b.d) - Math.max(a.w, a.d));

        let currentZOffset = 0;
        node.innerWidth = 0;
        let remainingItems = [...layoutItems];

        while (remainingItems.length > 0) {
            let itemsInCurrentRow = [];
            let rowWidth = 0;
            let rowMaxActualDepth = 0; 
            let availableRowWidth; 

            if (itemsInCurrentRow.length === 0 && remainingItems.length > 0) {
                 const firstItem = remainingItems[0];
                 availableRowWidth = firstItem.w; 
            } else {
                let totalRemainingArea = 0;
                remainingItems.forEach(item => totalRemainingArea += item.w * item.d);
                availableRowWidth = Math.max(Math.sqrt(totalRemainingArea), node.innerWidth * 0.5, MIN_LAYOUT_DIMENSION);
            }

            let tempNotFitting = [];
            for (let i = 0; i < remainingItems.length; i++) {
                const item = remainingItems[i];
                if (itemsInCurrentRow.length === 0) { 
                    itemsInCurrentRow.push(item);
                    rowWidth = item.w;
                    rowMaxActualDepth = Math.max(rowMaxActualDepth, item.d);
                } else if (rowWidth + ITEM_SPACING + item.w <= availableRowWidth * 1.5 || itemsInCurrentRow.length < 2 ) { 
                    itemsInCurrentRow.push(item);
                    rowWidth += ITEM_SPACING + item.w;
                    rowMaxActualDepth = Math.max(rowMaxActualDepth, item.d);
                } else {
                    tempNotFitting.push(item);
                }
            }
            
            if (itemsInCurrentRow.length === 0) { 
                 if(remainingItems.length > 0) { 
                    const fallbackItem = remainingItems.shift();
                    itemsInCurrentRow.push(fallbackItem);
                    rowWidth = fallbackItem.w;
                    rowMaxActualDepth = Math.max(rowMaxActualDepth, fallbackItem.d);
                    tempNotFitting = remainingItems; 
                 } else {
                    break; 
                 }
            }

            let currentXOffsetInRow = 0;
            itemsInCurrentRow.forEach(item => {
                item.node.prelimX = currentXOffsetInRow + item.w / 2;
                item.node.prelimZ = currentZOffset + item.d / 2; 
                currentXOffsetInRow += item.w + ITEM_SPACING;
            });

            node.innerWidth = Math.max(node.innerWidth, rowWidth);
            currentZOffset += rowMaxActualDepth + ITEM_SPACING;
            remainingItems = tempNotFitting;
        }

        node.innerDepth = (currentZOffset > 0) ? currentZOffset - ITEM_SPACING : 0;

        layoutItems.forEach(item => { 
            if (item.node.prelimX !== undefined) { 
                item.node.renderOffsetX = item.node.prelimX - node.innerWidth / 2;
                item.node.renderOffsetZ = item.node.prelimZ - node.innerDepth / 2;
            } else {
                item.node.renderOffsetX = 0;
                item.node.renderOffsetZ = 0;
            }
        });
        
        node.calculatedOuterWidth = node.innerWidth + 2 * PADDING;
        node.calculatedOuterDepth = node.innerDepth + 2 * PADDING;
        node.foundationHeight = FOUNDATION_HEIGHT;
        return { width: node.calculatedOuterWidth, depth: node.calculatedOuterDepth };

    } else { 
        if (node.buildingHeight === undefined) {
             node.buildingHeight = Math.max((node.count || 0) * HEIGHT_FACTOR, MIN_VISIBLE_BUILDING_HEIGHT);
        }
        const w = node.loc > 0 ? node.loc : MIN_LAYOUT_DIMENSION;
        const d = node.loc > 0 ? node.loc : MIN_LAYOUT_DIMENSION;
        return { width: w, depth: d };
    }
}

// Function to create Three.js objects
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
        foundationMesh.position.set(baseCenterPosition.x, baseCenterPosition.y + node.foundationHeight / 2, baseCenterPosition.z);
        foundationMesh.userData = { type: 'Directory', nodeData: node, depthLevel: depthLevel };
        parentThreeGroup.add(foundationMesh);
        pickableObjects.push(foundationMesh);
        const childrenBaseY = baseCenterPosition.y + node.foundationHeight;
        const childrenOriginX = baseCenterPosition.x;
        const childrenOriginZ = baseCenterPosition.z;
        
        const childrenToDraw = [...(node.childFiles || []), ...(node.childDirectories || [])];
        childrenToDraw.forEach(childNode => {
            if(childNode.renderOffsetX === undefined || childNode.renderOffsetZ === undefined) {
                childNode.renderOffsetX = 0;
                childNode.renderOffsetZ = 0;
            }
            const childCenterPos = new THREE.Vector3(childrenOriginX + childNode.renderOffsetX, childrenBaseY, childrenOriginZ + childNode.renderOffsetZ);
            createThreeObjects(childNode, parentThreeGroup, childCenterPos, depthLevel + 1);
        });

    } else { 
        const buildingWidth = node.loc > 0 ? node.loc : MIN_RENDER_DIMENSION;
        const buildingDepth = node.loc > 0 ? node.loc : MIN_RENDER_DIMENSION;
        const buildingHeight = node.buildingHeight;
        const buildingColor = getHeatColor(node.heat);
        const buildingMaterial = new THREE.MeshLambertMaterial({ color: buildingColor });
        const buildingGeo = new THREE.BoxGeometry(
            Math.max(buildingWidth, 0.1),
            Math.max(buildingHeight, 0.1),
            Math.max(buildingDepth, 0.1)
        );
        const buildingMesh = new THREE.Mesh(buildingGeo, buildingMaterial);
        buildingMesh.position.set(baseCenterPosition.x, baseCenterPosition.y + buildingHeight / 2, baseCenterPosition.z);
        buildingMesh.userData = { type: 'File', nodeData: node };
        parentThreeGroup.add(buildingMesh);
        pickableObjects.push(buildingMesh);
    }
}

// Mouse move and tooltip functions
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
                let locText = nodeData.loc !== undefined ? `${nodeData.loc} Lines` : 'N/A Lines';
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

// Renamed original init to initScene, now accepts nestedStructure
function initScene(currentNestedStructure) {
    preprocessFileData(currentNestedStructure);
    
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x000000);
    const aspect = window.innerWidth / window.innerHeight;
    camera = new THREE.PerspectiveCamera(75, aspect, 1, 50000);
    const canvas = document.getElementById('canvas');
    renderer = new THREE.WebGLRenderer({ antialias: true, canvas: canvas });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.shadowMap.enabled = true;
    controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;
    controls.minDistance = 1;
    controls.maxDistance = 20000;
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
         (currentNestedStructure.layoutChildrenData || []).forEach(itemData => {
             const childNode = itemData.node;
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
    animate(); // Start animation loop here
}

// New async function to load data and then initialize the scene
async function loadDataAndInitialize() {
    try {
        const response = await fetch('data.csv'); // Path to your CSV file
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status} - Could not load data.csv`);
        }
        const csvString = await response.text();
        const dynamicallyGeneratedNestedStructure = csvToNestedStructure(csvString);
        
        initScene(dynamicallyGeneratedNestedStructure); // Call the main scene initialization

    } catch (error) {
        console.error("Error loading or processing CSV data:", error);
        const canvasElement = document.getElementById('canvas');
        if(canvasElement) {
            canvasElement.outerHTML = `<div style="padding: 20px; color: red; text-align: center;">
                                         <p>Error loading data: ${error.message}</p>
                                         <p>Please ensure 'data.csv' is in the same directory as city.html and that you are running this from a web server.</p>
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
    updateTooltip(); // updateTooltip needs raycaster etc. which are init in initScene
    if (scene && camera && renderer) renderer.render(scene, camera);
}

// Start the application by loading data
loadDataAndInitialize();