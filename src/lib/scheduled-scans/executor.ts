import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { randomUUID } from 'crypto'
import { scannerService } from '@/lib/scanner'
import { apiError } from '@/lib/api/api-utils'
import { config } from '@/lib/config'
import { logger } from '@/lib/logger'
import { RegistryService } from '@/lib/registry/RegistryService'

export async function executeScheduledScan(id: string, triggerSource: 'MANUAL' | 'SCHEDULED' = 'MANUAL') {
  try {
    // Get the scheduled scan
    const scheduledScan = await prisma.scheduledScan.findUnique({
      where: { id },
      include: {
        selectedImages: {
          include: {
            image: true
          }
        }
      }
    })

    if (!scheduledScan) {
      return NextResponse.json(
        { error: 'Scheduled scan not found' },
        { status: 404 }
      )
    }

    if (!scheduledScan.enabled) {
      return NextResponse.json(
        { error: 'Scheduled scan is disabled' },
        { status: 400 }
      )
    }

    // Determine which images to scan based on selection mode
    let imagesToScan: any[] = []

    switch (scheduledScan.imageSelectionMode) {
      case 'SPECIFIC':
        imagesToScan = scheduledScan.selectedImages.map(si => si.image)
        break

      case 'PATTERN':
        if (scheduledScan.imagePattern) {
          const regex = new RegExp(scheduledScan.imagePattern)
          const allImages = await prisma.image.findMany({
            select: {
              id: true,
              name: true,
              tag: true,
              registry: true,
              source: true,
              dockerImageId: true,
              primaryRepositoryId: true
            }
          })
          imagesToScan = allImages.filter(img =>
            regex.test(`${img.name}:${img.tag}`)
          )
        }
        break

      case 'ALL':
        imagesToScan = await prisma.image.findMany({
          select: {
            id: true,
            name: true,
            tag: true,
            registry: true,
            source: true,
            dockerImageId: true,
            primaryRepositoryId: true
          }
        })
        // Registry sync caches package metadata, but does not create Image rows.
        // Include published GHCR packages so a new image can be scanned for the
        // first time by a scheduled ALL run.
        const ghcrRepositories = await prisma.repository.findMany({
          where: { status: 'ACTIVE', type: 'GHCR' }
        })
        const registryService = new RegistryService(prisma)
        const knownImages = new Set(imagesToScan.map(image =>
          `${image.name.replace(/^ghcr\.io\//i, '').toLowerCase()}:${image.tag}`
        ))

        for (const repository of ghcrRepositories) {
          let offset = 0
          while (true) {
            const packages = await registryService.listImages(repository.id, { limit: 100, offset })
            for (const pkg of packages) {
              try {
                const tags = await registryService.getTags(repository.id, pkg.namespace, pkg.name)
                if (!tags.some(tag => tag.name === 'latest')) continue

                const key = `${pkg.fullName.toLowerCase()}:latest`
                if (knownImages.has(key)) continue
                knownImages.add(key)
                imagesToScan.push({
                  id: `registry:${repository.id}:${pkg.fullName}`,
                  name: pkg.fullName,
                  tag: 'latest',
                  source: 'REGISTRY_PRIVATE',
                  primaryRepositoryId: repository.id,
                })
              } catch (error) {
                logger.warn(`[ScheduledScans] Could not list tags for ${pkg.fullName}: ${error}`)
              }
            }
            if (packages.length < 100) break
            offset += packages.length
          }
        }
        break

      case 'REPOSITORY':
        // TODO: Implement repository-based selection
        return NextResponse.json(
          { error: 'Repository-based selection not yet implemented' },
          { status: 501 }
        )
    }

    if (imagesToScan.length === 0) {
      return NextResponse.json(
        { error: 'No images found to scan' },
        { status: 400 }
      )
    }

    logger.info(`[ScheduledScans] ${id}: selected ${imagesToScan.length} images using ${scheduledScan.imageSelectionMode}`)

    // Create execution history record
    const executionId = randomUUID()
    const history = await prisma.scheduledScanHistory.create({
      data: {
        scheduledScanId: id,
        executionId,
        totalImages: imagesToScan.length,
        status: 'PENDING',
        triggerSource,
        triggeredBy: triggerSource === 'SCHEDULED' ? 'scheduler' : 'API'
      }
    })

    // Start scanning images (async process)
    // In a real implementation, this would be queued to a background job
    startScanExecution(history.id, imagesToScan).catch(error => {
      console.error('Error in scan execution:', error)
      // Update history with error
      prisma.scheduledScanHistory.update({
        where: { id: history.id },
        data: {
          status: 'FAILED',
          errorMessage: error.message,
          completedAt: new Date()
        }
      }).catch(console.error)
    })

    // Update last run time
    await prisma.scheduledScan.update({
      where: { id },
      data: {
        lastRunAt: new Date()
      }
    })

    return NextResponse.json({
      executionId,
      historyId: history.id,
      totalImages: imagesToScan.length,
      status: 'STARTED',
      message: `Scheduled scan execution started for ${imagesToScan.length} images`
    }, { status: 202 })

  } catch (error) {
    return apiError(error, 'Failed to execute scheduled scan');
  }
}

async function startScanExecution(historyId: string, images: any[]) {
  // Update status to running
  await prisma.scheduledScanHistory.update({
    where: { id: historyId },
    data: {
      status: 'RUNNING',
      startedAt: new Date()
    }
  })

  let queuedCount = 0
  let failedCount = 0
  const scanResults = []

  // Process each image
  for (const image of images) {
    let resultId: string | undefined
    try {
      // Create a scheduled scan result record
      const result = await prisma.scheduledScanResult.create({
        data: {
          history: {
            connect: {
              id: historyId
            }
          },
          imageId: image.id,
          imageName: image.name,
          imageTag: image.tag,
          status: 'PENDING',
          startedAt: new Date()
        }
      })
      resultId = result.id

      // Trigger actual scan using the scanner service
      // Map LOCAL_DOCKER to 'local' for the scanner service
      const source = image.source === 'LOCAL_DOCKER' ? 'local' :
                     image.source === 'REGISTRY' || image.source === 'REGISTRY_PRIVATE' ? 'registry' :
                     image.source || 'registry'

      const scanRequest = {
        image: image.name,
        tag: image.tag,
        source: source,
        dockerImageId: image.dockerImageId,
        repositoryId: image.primaryRepositoryId || image.repositoryId
      }

      const scanResponse = await scannerService.startScan(scanRequest)

      if (scanResponse.requestId) {
        // Link the scheduled scan result to the actual scan
        const scan = await prisma.scan.findUnique({
          where: { requestId: scanResponse.requestId }
        })

        if (scan) {
          await prisma.scheduledScanResult.update({
            where: { id: result.id },
            data: {
              imageId: scan.imageId,
              scanId: scan.id,
              status: 'RUNNING'
            }
          })
          scanResults.push({ resultId: result.id, scanId: scan.id })
        } else {
          throw new Error(`Scan record not found for request ${scanResponse.requestId}`)
        }

        queuedCount++
      } else {
        // Scan failed to start
        await prisma.scheduledScanResult.update({
          where: { id: result.id },
          data: {
            status: 'FAILED',
            completedAt: new Date(),
            errorMessage: 'Failed to start scan'
          }
        })
        failedCount++
      }

      // Update progress
      await prisma.scheduledScanHistory.update({
        where: { id: historyId },
        data: {
          // Queued scans are not completed scans.
          scannedImages: failedCount,
          failedImages: failedCount
        }
      })

    } catch (error) {
      console.error(`Error scanning image ${image.name}:${image.tag}:`, error)
      failedCount++
      if (resultId) {
        await prisma.scheduledScanResult.update({
          where: { id: resultId },
          data: {
            status: 'FAILED',
            completedAt: new Date(),
            errorMessage: error instanceof Error ? error.message : String(error),
          }
        })
      }

      // Update failed count
      await prisma.scheduledScanHistory.update({
        where: { id: historyId },
        data: {
          scannedImages: failedCount,
          failedImages: failedCount
        }
      })
    }
  }

  // Start monitoring scan completions
  // Update execution status based on initial results
  await prisma.scheduledScanHistory.update({
    where: { id: historyId },
    data: {
      status: queuedCount === 0 ? 'FAILED' : 'RUNNING',
      completedAt: queuedCount === 0 ? new Date() : null,
      scannedImages: failedCount,
      failedImages: failedCount
    }
  })

  if (scanResults.length > 0) {
    monitorScanCompletion(historyId, scanResults, failedCount).catch(console.error)
  }
}

async function monitorScanCompletion(historyId: string, scanResults: any[], initialFailedCount: number) {
  // Allow every queued scan its configured timeout, accounting for concurrency.
  const intervalMs = 10_000
  const timeoutMinutes = Math.max(15,
    Math.ceil(scanResults.length / Math.max(1, config.maxConcurrentScans)) * config.scanTimeoutMinutes + 5)
  const maxAttempts = Math.ceil(timeoutMinutes * 60_000 / intervalMs)
  let attempts = 0
  let checking = false

  const checkInterval = setInterval(async () => {
    if (checking) return
    checking = true
    attempts++

    try {
      // Check all scan results
      let allCompleted = true
      let completedCount = 0
      let failedCount = 0
      let partialCount = 0

      for (const { resultId, scanId } of scanResults) {
        const scan = await prisma.scan.findUnique({
          where: { id: scanId },
          include: {
            metadata: {
              select: {
                vulnerabilityCritical: true,
                vulnerabilityHigh: true,
                vulnerabilityMedium: true,
                vulnerabilityLow: true
              }
            }
          }
        })

        if (scan) {
          if (scan.status === 'SUCCESS' || scan.status === 'PARTIAL' || scan.status === 'FAILED' || scan.status === 'CANCELLED') {
            // Update scheduled scan result status (vulnerability data is referenced from the scan)
            await prisma.scheduledScanResult.update({
              where: { id: resultId },
              data: {
                status: scan.status,
                completedAt: new Date(),
                errorMessage: scan.status === 'FAILED' || scan.status === 'CANCELLED' ? `Scan ${scan.status.toLowerCase()}` : null
              }
            })

            if (scan.status === 'SUCCESS') {
              completedCount++
            } else if (scan.status === 'PARTIAL') {
              partialCount++
            } else {
              failedCount++
            }
          } else {
            allCompleted = false
          }
        } else {
          allCompleted = false
        }
      }

      await prisma.scheduledScanHistory.update({
        where: { id: historyId },
        data: {
          scannedImages: initialFailedCount + completedCount + partialCount + failedCount,
          failedImages: initialFailedCount + failedCount,
        }
      })

      if (allCompleted || attempts >= maxAttempts) {
        clearInterval(checkInterval)

        // Get final counts
        if (attempts >= maxAttempts && !allCompleted) {
          await prisma.scheduledScanResult.updateMany({
            where: { scheduledScanHistoryId: historyId, status: { in: ['PENDING', 'RUNNING'] } },
            data: { status: 'FAILED', completedAt: new Date(), errorMessage: `Scan monitoring timeout after ${timeoutMinutes} minutes` }
          })
        }

        const history = await prisma.scheduledScanHistory.findUnique({
          where: { id: historyId },
          include: {
            scanResults: {
              where: { status: { in: ['SUCCESS', 'PARTIAL', 'FAILED', 'CANCELLED'] } }
            }
          }
        })

        const successCount = history?.scanResults.filter(r => r.status === 'SUCCESS').length || 0
        const partialCount = history?.scanResults.filter(r => r.status === 'PARTIAL').length || 0
        const recordedFailedCount = history?.scanResults.filter(r => r.status === 'FAILED' || r.status === 'CANCELLED').length || 0
        const totalImages = history?.totalImages || 0
        const unrecordedFailedCount = Math.max(0, totalImages - (history?.scanResults.length || 0))
        const totalFailedCount = recordedFailedCount + unrecordedFailedCount

        // Update final status
        await prisma.scheduledScanHistory.update({
          where: { id: historyId },
          data: {
            status: attempts >= maxAttempts && !allCompleted ? 'FAILED' :
                   totalFailedCount === totalImages ? 'FAILED' :
                   totalFailedCount > 0 || partialCount > 0 ? 'PARTIAL' : 'COMPLETED',
            completedAt: new Date(),
            scannedImages: successCount + partialCount + totalFailedCount,
            failedImages: totalFailedCount,
            errorMessage: attempts >= maxAttempts && !allCompleted ? `Scan monitoring timeout after ${timeoutMinutes} minutes` : null
          }
        })
      }
    } catch (error) {
      console.error('Error monitoring scan completion:', error)
      clearInterval(checkInterval)
    } finally {
      checking = false
    }
  }, intervalMs)
}
